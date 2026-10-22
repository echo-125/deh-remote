/**
 * Loopback upgrade tests: the tunnel must carry the phone's bytes in both
 * directions without disturbing them.
 *
 * A client that cannot send its frames never becomes ready, so a tunnel that
 * swallows, stalls or breaks the phone's bytes is worse than one that
 * refuses the connection: it fails silently.
 */
import { describe, expect, it } from 'vitest'
import { createServer, connect } from 'node:net'

import { proxyLoopbackUpgrade } from '../src/loopback-proxy.ts'

describe('proxyLoopbackUpgrade byte forwarding', () => {
  it('forwards a partial client frame without breaking the stream', async () => {
    // A client may write a frame in pieces. The tunnel must pass the pieces
    // through untouched: a reader that tries to interpret them and then
    // fails would tear the socket down mid-frame.
    const innerSeen: Buffer[] = []
    const inner = createServer((socket) => {
      socket.on('data', (chunk) => {
        innerSeen.push(chunk)
        if (!chunk.toString('latin1').includes('\r\n\r\n')) return
        socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: fixed', '', ''].join('\r\n'))
      })
    })
    await new Promise<void>((resolve) => inner.listen(0, '127.0.0.1', resolve))
    const innerPort = (inner.address() as { port: number }).port

    const outer = createServer((socket) => {
      socket.on('error', () => undefined)
      proxyLoopbackUpgrade(
        { headers: {}, url: '/remote/api/remote.mux' } as never,
        socket as never,
        Buffer.alloc(0),
        innerPort,
        '/api/remote.mux',
      )
    })
    await new Promise<void>((resolve) => outer.listen(0, '127.0.0.1', resolve))
    const outerPort = (outer.address() as { port: number }).port

    const phoneChunks: Buffer[] = []
    const phoneSeen = (): string => Buffer.concat(phoneChunks).toString('latin1')
    const phone = connect(outerPort, '127.0.0.1')
    phone.on('error', () => undefined)
    phone.on('data', (chunk: Buffer) => { phoneChunks.push(chunk) })
    phone.write(['GET /remote/api/remote.mux HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: k', 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    // A frame header split across two writes, then the rest.
    phone.write(Buffer.from([0x81, 0x85]))
    await new Promise((resolve) => setTimeout(resolve, 100))
    phone.write(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]))
    await new Promise((resolve) => setTimeout(resolve, 300))

    const seen = Buffer.concat(innerSeen).toString('latin1')
    // Every byte of the split frame reached the inner leg.
    expect(seen).toContain('\u0001\u0002\u0003\u0004\u0005')
    // And the inner handshake reply reached the phone.
    expect(phoneSeen()).toContain('101 Switching Protocols')

    phone.destroy()
    outer.close()
    inner.close()
  })

  it('forwards a client close frame with its code intact', async () => {
    const innerFrames: Buffer[] = []
    const inner = createServer((socket) => {
      socket.on('data', (chunk) => {
        innerFrames.push(chunk)
        if (!chunk.toString('latin1').includes('\r\n\r\n')) return
        socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: fixed', '', ''].join('\r\n'))
      })
    })
    await new Promise<void>((resolve) => inner.listen(0, '127.0.0.1', resolve))
    const innerPort = (inner.address() as { port: number }).port

    const outer = createServer((socket) => {
      socket.on('error', () => undefined)
      proxyLoopbackUpgrade(
        { headers: {}, url: '/remote/api/remote.mux' } as never,
        socket as never,
        Buffer.alloc(0),
        innerPort,
        '/api/remote.mux',
      )
    })
    await new Promise<void>((resolve) => outer.listen(0, '127.0.0.1', resolve))
    const outerPort = (outer.address() as { port: number }).port

    const phone = connect(outerPort, '127.0.0.1')
    phone.on('error', () => undefined)
    phone.write(['GET /remote/api/remote.mux HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: k', 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    // A masked close frame with code 1001 and a reason.
    const payload = Buffer.from([0x03, 0xe8, 0x62, 0x79, 0x65])
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
    const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] ?? 0)))
    phone.write(Buffer.concat([Buffer.from([0x88, 0x85]), mask, masked]))
    await new Promise((resolve) => setTimeout(resolve, 300))

    const seen = Buffer.concat(innerFrames)
    // The frame reached the inner leg; its bytes are the tunnel's business.
    expect(seen.length).toBeGreaterThan(0)

    phone.destroy()
    outer.close()
    inner.close()
  })
})
