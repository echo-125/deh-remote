/**
 * Loopback upgrade tests: the tunnel must answer the inner gateway's
 * heartbeat on the phone's behalf.
 *
 * The inner gateway pings the stream and terminates it when the Pong never
 * arrives. A browser cannot send a Pong, so without the tunnel answering,
 * a phone-side stream dies after two missed heartbeats and the client
 * reconnects forever.
 */
import { describe, expect, it } from 'vitest'
import { createServer, connect } from 'node:net'

import { proxyLoopbackUpgrade } from '../src/loopback-proxy.ts'
import { parseWsFrameHeader, WS_OP_PONG } from '../src/ws-control.ts'

describe('proxyLoopbackUpgrade heartbeat', () => {
  it('answers the inner Ping with a Pong', async () => {
    const innerFrames: Buffer[] = []
    // The inner leg: greets with 101, then pings.
    const inner = createServer((socket) => {
      socket.on('data', (chunk) => innerFrames.push(chunk))
      socket.on('data', (chunk) => {
        const text = chunk.toString('latin1')
        if (!text.includes('\r\n\r\n')) return
        socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: fixed', '', ''].join('\r\n'))
        // An unmasked server-to-client Ping with an empty payload.
        socket.write(Buffer.from([0x89, 0x00]))
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

    // The phone side: never answers anything, like a browser.
    const phone = connect(outerPort, '127.0.0.1')
    phone.on('error', () => undefined)
    phone.write(['GET /remote/api/remote.mux HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: k', 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'))

    await new Promise((resolve) => setTimeout(resolve, 500))

    // The inner leg received a Pong for the Ping it sent.
    const sawPong = innerFrames.some((frame) => {
      const header = parseWsFrameHeader(frame)
      return header?.opcode === WS_OP_PONG
    })

    phone.destroy()
    outer.close()
    inner.close()

    expect(sawPong).toBe(true)
  })
})
