/**
 * WebSocket control-frame tests.
 *
 * The remote event stream is a raw tunnel; the inner gateway keeps it
 * alive with Ping frames and drops it when the Pong never comes back. A
 * browser cannot send a Pong, so the tunnel must answer on its behalf.
 */
import { describe, expect, it } from 'vitest'

import { buildMaskedPong, parseWsFrameHeader, WS_OP_PING, WS_OP_PONG } from '../src/ws-control.ts'

describe('parseWsFrameHeader', () => {
  it('parses a short unmasked frame', () => {
    const header = parseWsFrameHeader(Buffer.from([0x81, 0x05, 1, 2, 3, 4, 5]))
    expect(header?.opcode).toBe(0x1)
    expect(header?.length).toBe(5)
    expect(header?.headerBytes).toBe(2)
    expect(header?.masked).toBe(false)
  })

  it('parses a masked frame and exposes the key', () => {
    const header = parseWsFrameHeader(Buffer.from([0x89, 0x85, 0xaa, 0xbb, 0xcc, 0xdd]))
    expect(header?.opcode).toBe(WS_OP_PING)
    expect(header?.length).toBe(5)
    expect(header?.masked).toBe(true)
    expect(header?.headerBytes).toBe(6)
    expect(header?.mask?.toString('hex')).toBe('aabbccdd')
  })

  it('parses a 16-bit length frame', () => {
    const header = parseWsFrameHeader(Buffer.from([0x81, 0x7e, 0x01, 0x00]))
    expect(header?.length).toBe(256)
    expect(header?.headerBytes).toBe(4)
  })

  it('returns undefined while the header is incomplete', () => {
    expect(parseWsFrameHeader(Buffer.from([0x81]))).toBeUndefined()
    expect(parseWsFrameHeader(Buffer.from([0x81, 0xfe]))).toBeUndefined()
    expect(parseWsFrameHeader(Buffer.from([0x89, 0x85, 0xaa]))).toBeUndefined()
  })
})

describe('buildMaskedPong', () => {
  it('builds a masked Pong carrying the Ping payload', () => {
    const pong = buildMaskedPong(Buffer.from('hello'))
    expect(pong[0]).toBe(0x80 | WS_OP_PONG)
    expect((pong[1] & 0x80) !== 0).toBe(true)
    expect(pong[1] & 0x7f).toBe(5)
    const mask = pong.subarray(2, 6)
    const payload = pong.subarray(6)
    const decoded = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] ?? 0)))
    expect(decoded.toString()).toBe('hello')
  })

  it('builds an empty Pong for an empty Ping', () => {
    const pong = buildMaskedPong(Buffer.alloc(0))
    expect(pong[0]).toBe(0x80 | WS_OP_PONG)
    expect(pong[1] & 0x7f).toBe(0)
    expect(pong.length).toBe(6)
  })

  it('encodes a 16-bit length header for a long payload', () => {
    const pong = buildMaskedPong(Buffer.alloc(200))
    expect(pong[1] & 0x7f).toBe(126)
    expect(pong.readUInt16BE(2)).toBe(200)
  })
})
