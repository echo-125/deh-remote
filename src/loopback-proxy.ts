/**
 * Whether a buffer plausibly starts a WebSocket frame.
 *
 * A client-to-server frame is masked, and its length field has a defined
 * range. A buffer that cannot be a frame start is not a frame: forwarding it
 * untouched is the only safe answer, because holding bytes back would stall
 * the client that sent them.
 * @param buffer - the bytes to inspect.
 * @returns true when the bytes could be the start of a frame.
 */
function looksLikeFrameStart(buffer: Buffer): boolean {
  if (buffer.length < 2) return true
  const opcode = buffer[0] & 0x0f
  if (opcode > 0x0a) return false
  const length = buffer[1] & 0x7f
  if (length < 126) return true
  return buffer.length >= (length === 126 ? 4 : 10)
}
/**
 * Loopback-shaped reverse proxy used by the remote desktop channel: after
 * the pairing cookie gate, traffic is re-issued to 127.0.0.1 so sibling
 * plugin fences (socket + Host loopback) accept it. Origin, cookies, and
 * caller-controlled Sec-Fetch markers are dropped. HTTP requests receive a
 * synthetic same-origin marker after the pairing gate so sibling loopback
 * routes that require a browser tripwire accept the authenticated proxy.
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import type { Duplex } from 'node:stream'
import { writeJson } from './http.ts'
import type { InnerAuth } from './inner-auth.ts'
import { WS_OP_CLOSE, WS_OP_PING, buildMaskedPong, parseWsFrameHeader, unmaskWsPayload } from './ws-control.ts'
import { appendChannelLog, channelLogArmed } from './channel-log.ts'

/** WebSocket handshake headers forwarded to the loopback upstream. */
const WS_FORWARD_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
] as const

/** Response headers copied from the loopback upstream (no hop-by-hop). */
const HTTP_FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
] as const

/**
 * Pipe one HTTP request to loopback and stream the response back.
 * @param req - the already-gated outer request.
 * @param res - the outer response.
 * @param port - local webServer port.
 * @param upstreamPath - path + query on 127.0.0.1 (must start with `/`).
 * @param auth - when given, the process's inner browser-auth credential is
 *   attached so the connection plugin's /api route (fence + browser auth,
 *   authority-bound cookie, no loopback exemption on this cohort) accepts
 *   the re-issued request; a 401 answer invalidates the cached credential.
 */
export function proxyLoopbackHttp(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  upstreamPath: string,
  auth?: InnerAuth,
): void {
  void Promise.resolve(auth?.ready())
    .catch(() => undefined)
    .then((cookie) => { pipeLoopbackHttp(req, res, port, upstreamPath, auth, typeof cookie === 'string' ? cookie : undefined) })
}

function pipeLoopbackHttp(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  upstreamPath: string,
  auth: InnerAuth | undefined,
  cookie: string | undefined,
): void {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${String(port)}`,
    'sec-fetch-site': 'same-origin',
  }
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string') headers['content-type'] = contentType
  const contentLength = req.headers['content-length']
  if (typeof contentLength === 'string') headers['content-length'] = contentLength
  const accept = req.headers.accept
  if (typeof accept === 'string') headers.accept = accept
  if (cookie !== undefined) headers.cookie = cookie

  const upstream = httpRequest({
    host: '127.0.0.1',
    port,
    path: upstreamPath,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    // The cached credential went stale (secret rotation, credential store
    // reset): drop it so the next request re-redeems. The in-flight response
    // still pipes through untouched.
    if (upstreamRes.statusCode === 401 && cookie !== undefined) auth?.invalidate()
    const out: OutgoingHttpHeaders = {}
    for (const name of HTTP_FORWARD_RESPONSE_HEADERS) {
      const value = upstreamRes.headers[name]
      if (value !== undefined) out[name] = value
    }
    res.writeHead(upstreamRes.statusCode ?? 502, out)
    upstreamRes.pipe(res)
    // Inner leg died mid-response (reset, truncation): tear the outer leg
    // down instead of letting the truncated response raise an unhandled
    // 'error' with no listener.
    upstreamRes.on('error', () => { res.destroy() })
    // Outer leg died before the response finished (phone left mid-request):
    // reset the inner request so the loopback server stops working on a call
    // nobody will read. Guarded so a normal completion never destroys a
    // keep-alive socket the agent would reuse.
    res.on('close', () => {
      if (!upstreamRes.readableEnded) upstream.destroy()
    })
  })
  upstream.on('error', () => {
    if (!res.headersSent) {
      writeJson(res, 502, { ok: false, error: { code: 'upstream-failure', message: 'upstream request failed' } })
      return
    }
    res.destroy()
  })
  // The outer request aborted mid-body: reset the inner request instead of
  // feeding it a truncated body that still gets processed (mirror of the
  // upgrade path's two-leg teardown).
  req.on('error', () => { upstream.destroy() })
  req.pipe(upstream)
}

/**
 * Rebuild a WebSocket handshake as loopback-shaped and pipe both directions.
 * @param req - the already-gated upgrade request.
 * @param socket - the client duplex.
 * @param head - bytes already read past the handshake.
 * @param port - local webServer port.
 * @param upstreamPath - path + query on 127.0.0.1.
 * @param cookie - the inner browser-auth credential for the handshake, when
 *   the upstream route enforces it (the gateway event-stream mux does).
 * @param onInnerStatus - optional observer for the inner handshake status line.
 *   The inner leg's reply is piped straight to the client, so without this
 *   the proxy cannot tell "the inner route accepted" from "the inner route
 *   refused" - the two look identical from the outside.
 */
export function proxyLoopbackUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  port: number,
  upstreamPath: string,
  cookie?: string,
  onInnerStatus?: (status: number) => void,
): void {
  const lines = [
    `GET ${upstreamPath} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
  ]
  if (cookie !== undefined) lines.push(`Cookie: ${cookie}`)
  for (const name of WS_FORWARD_HEADERS) {
    const value = req.headers[name]
    if (value === undefined) continue
    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
  }
  const handshake = `${lines.join('\r\n')}\r\n\r\n`

  const legStartedAt = Date.now()
  const upstream = connect(port, '127.0.0.1')
  // A half-open tunnel path (dead-but-alive edge connection) would otherwise
  // let the phone's mux socket sit stale for minutes: keepalive probes the
  // pipe periodically and destroys both legs on the first real gap, so the
  // client's reconnect + stream re-baseline re-syncs the feed in seconds.
  ;(socket as unknown as import('node:net').Socket).setKeepAlive(true, 20_000)
  upstream.setKeepAlive(true, 20_000)
  const tearDown = (): void => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', tearDown)
  socket.on('error', tearDown)
  upstream.on('close', () => { socket.destroy() })
  socket.on('close', () => { upstream.destroy() })
  upstream.on('connect', () => {
    upstream.write(handshake)
    if (head.length > 0) upstream.write(head)
    // Watch the inner handshake reply: the first upstream bytes carry the
    // status line the inner route answered with (101 on success, 401/403 when
    // it refused). It is forwarded verbatim to the client either way.
    // Answer the inner gateway's Ping frames here. The inner gateway keeps
    // the stream alive with WebSocket heartbeats and terminates the socket
    // when the Pong never comes back. A browser cannot send a Pong (the
    // WebSocket API exposes no control frames), so a phone-side stream would
    // always die after two missed heartbeats and the client would reconnect
    // forever. Answering on the phone's behalf is what makes the remote
    // channel usable from a browser at all.
    //
    // The listener only observes: a socket that is both piped and listened
    // to hands each chunk to both readers, and the pipe is what carries the
    // bytes. The listener must never write to the phone leg and must never
    // hold a byte back - a client that cannot send its frames never becomes
    // ready, and a tunnel that swallows bytes hides that entirely.
    let observed: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let observedHandshake = false
    const onUpstreamFrame = (chunk: Buffer): void => {
      observed = observed.length === 0 ? chunk : Buffer.concat([observed, chunk])
      if (!observedHandshake) {
        const end = observed.indexOf('\r\n\r\n')
        if (end === -1) return
        observedHandshake = true
        if (onInnerStatus !== undefined) {
          const match = /^HTTP\/1\.[01] (\d{3})/.exec(observed.toString('latin1').slice(0, end))
          if (match !== null) onInnerStatus(Number(match[1]))
        }
        observed = observed.subarray(end + 4)
      }
      for (;;) {
        const header = parseWsFrameHeader(observed)
        if (header === undefined) break
        if (observed.length < header.headerBytes + header.length) break
        const total = header.headerBytes + header.length
        const frame = observed.subarray(0, total)
        observed = observed.subarray(total)
        if (header.opcode !== WS_OP_PING) continue
        // Answer the heartbeat for the inner gateway. The Ping itself still
        // reaches the phone through the pipe, and the browser answers its
        // own copy at the protocol level.
        upstream.write(buildMaskedPong(Buffer.from(frame.subarray(header.headerBytes))))
      }
    }
    upstream.on('data', onUpstreamFrame)
    upstream.on('close', () => {
      upstream.off('data', onUpstreamFrame)
    })
    // Observe the phone leg. A read-only listener on a piped socket hands
    // each chunk to both readers and changes nothing: the mutation test in
    // tests/loopback-forwarding.spec.ts covers that the phone's bytes still
    // reach the inner leg byte for byte. The handshake is skipped first, or
    // every frame after it would be read at the wrong offset.
    let fromPhone: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let phoneHandshakeSeen = false
    const onPhoneFrame = (chunk: Buffer): void => {
      fromPhone = fromPhone.length === 0 ? chunk : Buffer.concat([fromPhone, chunk])
      if (!phoneHandshakeSeen) {
        const end = fromPhone.indexOf('\r\n\r\n')
        if (end === -1) return
        phoneHandshakeSeen = true
        fromPhone = fromPhone.subarray(end + 4)
      }
      for (;;) {
        const header = parseWsFrameHeader(fromPhone)
        if (header === undefined) break
        if (fromPhone.length < header.headerBytes + header.length) break
        const total = header.headerBytes + header.length
        const frame = fromPhone.subarray(0, total)
        fromPhone = fromPhone.subarray(total)
        if (header.opcode === WS_OP_CLOSE) {
          const body = header.masked && header.mask !== undefined
            ? unmaskWsPayload(Buffer.from(frame.subarray(header.headerBytes)), header.mask)
            : Buffer.from(frame.subarray(header.headerBytes))
          const code = body.length >= 2 ? body.readUInt16BE(0) : 0
          const reason = body.length > 2 ? body.subarray(2).toString('utf8') : ''
          appendChannelLog({
            at: Date.now(),
            path: 'phone-close',
            credentialed: true,
            outcome: 'phone-close-' + String(code) + (reason === '' ? '' : ':' + reason),
            status: code,
          })
          continue
        }
        if (header.opcode !== 0x1) continue
        const body = header.masked && header.mask !== undefined
          ? unmaskWsPayload(Buffer.from(frame.subarray(header.headerBytes)), header.mask)
          : Buffer.from(frame.subarray(header.headerBytes))
        const text = body.toString('utf8')
        let summary = text.slice(0, 60)
        try {
          const parsed: unknown = JSON.parse(text)
          if (typeof parsed === 'object' && parsed !== null) {
            const record = parsed as { type?: unknown; endpoint?: unknown }
            summary = String(record.type ?? '?') + (record.endpoint === undefined ? '' : ':' + String(record.endpoint))
          }
        } catch {
          summary = 'unparsable-text'
        }
        appendChannelLog({
          at: Date.now(),
          path: 'phone-tx',
          credentialed: true,
          outcome: summary,
          status: header.length,
        })
      }
    }
    socket.on('data', onPhoneFrame)
    socket.on('close', () => {
      socket.off('data', onPhoneFrame)
    })
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
}
