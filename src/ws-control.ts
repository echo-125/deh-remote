/**
 * Minimal WebSocket control-frame handling for the loopback proxy.
 *
 * The remote event stream is a raw TCP tunnel between the phone and the
 * inner gateway. The inner gateway keeps the socket alive with WebSocket
 * Ping frames and terminates it when the Pong never comes back. A browser
 * cannot answer: the WebSocket API exposes no way to send a control frame.
 * So the tunnel has to answer on the phone's behalf - otherwise the inner
 * gateway drops the stream after two missed heartbeats and the client
 * reconnects forever.
 *
 * Only the frame header is parsed: the payload is opaque, and a control
 * frame is never fragmented, so the parse stays exact.
 *
 * @module @echo-125/deh-remote/ws-control

/** The control opcodes this tunnel cares about. */
export const WS_OP_PING = 0x9
export const WS_OP_PONG = 0xa
export const WS_OP_CLOSE = 0x8

/**
 * Unmask a client-to-server frame payload in place.
 * @param payload - the raw payload bytes.
 * @param mask - the four-byte masking key.
 * @returns a copy of the payload with the mask removed.
 */
export function unmaskWsPayload(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.from(payload)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = out[i] ^ (mask[i % 4] ?? 0)
  }
  return out
}

/** One parsed frame header. */
export interface WsFrameHeader {
  /** The opcode. */
  opcode: number
  /** The payload length in bytes. */
  length: number
  /** The number of bytes the frame header occupies. */
  headerBytes: number
  /** Whether the payload is masked (client to server frames are). */
  masked: boolean
  /** The 4-byte masking key, when masked. */
  mask?: Buffer
}

/**
 * Parse the header of the frame starting at the head of a buffer.
 * @param buffer - the bytes received so far.
 * @returns the header, or undefined when more bytes are needed.
 */
export function parseWsFrameHeader(buffer: Buffer): WsFrameHeader | undefined {
  if (buffer.length < 2) return undefined
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    length = Number(big)
    offset = 10
  }
  if (masked) {
    if (buffer.length < offset + 4) return undefined
    return {
      opcode,
      length,
      headerBytes: offset + 4,
      masked: true,
      mask: buffer.subarray(offset, offset + 4),
    }
  }
  return { opcode, length, headerBytes: offset, masked: false }
}

/**
 * Build a masked Pong carrying the given Ping payload.
 *
 * The mask is required: a client-to-server frame that is not masked is a
 * protocol error, and the inner gateway would close the socket on it.
 * @param payload - the Ping payload to echo.
 * @returns the encoded frame.
 */
export function buildMaskedPong(payload: Buffer): Buffer {
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) {
    masked[i] = masked[i] ^ (mask[i % 4] ?? 0)
  }
  const header = payload.length < 126
    ? Buffer.from([0x80 | WS_OP_PONG, 0x80 | payload.length])
    : Buffer.from([0x80 | WS_OP_PONG, 0x80 | 126, 0, 0])
  if (payload.length < 126) return Buffer.concat([header, mask, masked])
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, mask, masked])
}
