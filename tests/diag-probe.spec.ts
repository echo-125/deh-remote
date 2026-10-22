/**
 * Diagnostics probe tests: the probe is opt-in and must stay observation-only.
 * It samples the mux leg (handshake outcome, rewrite, device credential,
 * survival time) and counts REST statuses, and it must never change the
 * behaviour of the transports it wraps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REMOTE_CHANNEL_RULES } from '../src/remote-channel-rules.ts'
import { diagArmed, installDiagProbe, type MuxLegSample } from '../src/client/diag-probe.ts'

const MUX = REMOTE_CHANNEL_RULES.wsPaths[0]

/** Minimal WebSocket stand-in that records listeners and lets tests drive lifecycle. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  listeners: Record<string, ((event?: unknown) => void)[]> = {}
  sent: unknown[] = []
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: string, fn: (event?: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  fire(type: string, event?: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
  send(data: unknown): void { this.sent.push(data) }
  close(): void { /* no-op: lifecycle is driven by fire() */ }
}

function makeWindow(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, string>()
  return {
    location: { href: 'http://192.168.1.100:56058/pair-app', search: '', hostname: '192.168.1.100', protocol: 'http:' },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
    },
    isSecureContext: false,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    fetch: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    ...overrides,
  } as unknown as Window & typeof globalThis & { fetch: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('diagArmed', () => {
  it('is off by default so a normal paired phone never mounts the probe', () => {
    expect(diagArmed(makeWindow())).toBe(false)
  })

  it('arms on the query flag', () => {
    const win = makeWindow({ location: { href: 'http://h/pair-app?remoteDiag=1', search: '?remoteDiag=1', hostname: 'h', protocol: 'http:' } })
    expect(diagArmed(win)).toBe(true)
  })

  it('arms on the sessionStorage key', () => {
    const win = makeWindow()
    win.sessionStorage.setItem('dsh-remote-diag', '1')
    expect(diagArmed(win)).toBe(true)
  })

  it('stays off when storage access throws (private mode)', () => {
    const win = makeWindow({
      sessionStorage: { getItem: () => { throw new Error('denied') }, setItem: () => undefined },
    })
    expect(diagArmed(win)).toBe(false)
  })
})

describe('installDiagProbe', () => {
  it('records a mux leg with its rewrite and credential facts', () => {
    const win = makeWindow()
    const probe = installDiagProbe(win, { WebSocket: FakeWebSocket as unknown as typeof WebSocket })
    const rewritten = REMOTE_CHANNEL_RULES.remotePrefix + MUX + '?' + REMOTE_CHANNEL_RULES.deviceQuery + '=dev1'
    new win.WebSocket(rewritten)
    const leg = probe.snapshot().legs[0] as MuxLegSample
    expect(leg.url).toBe(rewritten)
    expect(leg.rewritten).toBe(true)
    expect(leg.hasDeviceQuery).toBe(true)
    probe.dispose()
  })

  it('marks a raw (unrewritten) mux leg as not rewritten', () => {
    const win = makeWindow()
    const probe = installDiagProbe(win, { WebSocket: FakeWebSocket as unknown as typeof WebSocket })
    new win.WebSocket(MUX)
    const leg = probe.snapshot().legs[0] as MuxLegSample
    expect(leg.rewritten).toBe(false)
    expect(leg.hasDeviceQuery).toBe(false)
    probe.dispose()
  })

  it('ignores non-mux sockets entirely', () => {
    const win = makeWindow()
    const probe = installDiagProbe(win, { WebSocket: FakeWebSocket as unknown as typeof WebSocket })
    new win.WebSocket('/api/events.mux')
    expect(probe.snapshot().legs).toHaveLength(0)
    probe.dispose()
  })

  it('records a socket that never opens as close-before-open', () => {
    const win = makeWindow()
    const probe = installDiagProbe(win, { WebSocket: FakeWebSocket as unknown as typeof WebSocket })
    new win.WebSocket(REMOTE_CHANNEL_RULES.remotePrefix + MUX)
    FakeWebSocket.instances[0].fire('close', { code: 1006, reason: '' })
    const leg = probe.snapshot().legs[0] as MuxLegSample
    expect(leg.outcome).toBe('close-before-open')
    expect(leg.code).toBe(1006)
    probe.dispose()
  })

  it('counts legs that opened but died inside the ready window', () => {
    const win = makeWindow()
    let clock = 0
    const probe = installDiagProbe(win, {
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      now: () => clock,
    })
    new win.WebSocket(REMOTE_CHANNEL_RULES.remotePrefix + MUX)
    FakeWebSocket.instances[0].fire('open')
    clock = 6_000
    FakeWebSocket.instances[0].fire('close', { code: 1006, reason: '' })
    const snap = probe.snapshot()
    expect(snap.legs[0]?.outcome).toBe('open')
    expect(snap.shortLived).toBe(1)
    probe.dispose()
  })

  it('does not count a long-lived leg as short-lived', () => {
    const win = makeWindow()
    let clock = 0
    const probe = installDiagProbe(win, {
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      now: () => clock,
    })
    new win.WebSocket(REMOTE_CHANNEL_RULES.remotePrefix + MUX)
    FakeWebSocket.instances[0].fire('open')
    clock = 30_000
    FakeWebSocket.instances[0].fire('close', { code: 1000, reason: '' })
    expect(probe.snapshot().shortLived).toBe(0)
    probe.dispose()
  })

  it('tallies REST statuses for /remote calls only', async () => {
    const win = makeWindow()
    const probe = installDiagProbe(win, { WebSocket: FakeWebSocket as unknown as typeof WebSocket })
    await win.fetch(REMOTE_CHANNEL_RULES.remotePrefix + '/api/session.list', {})
    await win.fetch('/api/session.list', {})
    const snap = probe.snapshot()
    expect(snap.rest['200']).toBe(1)
    probe.dispose()
  })


  it('does not mistake the mux path for the gateway prefix (regression)', () => {
    // The mux path itself contains "remote" (/api/remote.mux), so a substring
    // test would report a raw, unrewritten leg as rewritten - exactly the
    // distinction the probe exists to make.
    expect(MUX.includes('remote')).toBe(true)
    const win = makeWindow()
    const probe = installDiagProbe(win, { WebSocket: FakeWebSocket as unknown as typeof WebSocket })
    new win.WebSocket(MUX)
    expect(probe.snapshot().legs[0]?.rewritten).toBe(false)
    probe.dispose()
  })

  it('restores the original transports on dispose', () => {
    const win = makeWindow()
    const originalWs = win.WebSocket
    const originalFetch = win.fetch
    const probe = installDiagProbe(win, { WebSocket: FakeWebSocket as unknown as typeof WebSocket })
    expect(win.WebSocket).not.toBe(originalWs)
    probe.dispose()
    expect(win.WebSocket).toBe(originalWs)
    expect(win.fetch).toBe(originalFetch)
  })

  it('reports origin facts and the presence of the device credential', () => {
    const win = makeWindow()
    win.sessionStorage.setItem(REMOTE_CHANNEL_RULES.deviceKey, 'dev1')
    const probe = installDiagProbe(win, { WebSocket: FakeWebSocket as unknown as typeof WebSocket })
    const snap = probe.snapshot()
    expect(snap.origin.hostname).toBe('192.168.1.100')
    expect(snap.origin.isLoopback).toBe(false)
    expect(snap.devicePresent).toBe(true)
    probe.dispose()
  })
})
