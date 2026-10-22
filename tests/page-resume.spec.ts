/**
 * Page-resume recovery tests.
 *
 * A phone browser suspends a background tab and closes its WebSockets; the
 * official client only rediscovers the lost socket through its retry backoff.
 * The recovery must ask for a fresh attempt exactly on the hidden -> visible
 * edge, and never on a tab that was never suspended.
 */
import { describe, expect, it } from 'vitest'

import { installPageResumeRecovery, pageHidden } from '../src/client/page-resume.ts'

interface FakeWindow {
  hidden: boolean
  listeners: Map<string, Set<() => void>>
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

function makeWindow(hidden: boolean): FakeWindow {
  const listeners = new Map<string, Set<() => void>>()
  return {
    hidden,
    listeners,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
  }
}

function fire(win: FakeWindow, type: string): void {
  for (const listener of [...(win.listeners.get(type) ?? [])]) listener()
}

describe('pageHidden', () => {
  it('prefers the window hidden flag', () => {
    expect(pageHidden({ hidden: true })).toBe(true)
    expect(pageHidden({ hidden: false })).toBe(false)
  })

  it('falls back to the document visibility state', () => {
    expect(pageHidden({ document: { visibilityState: 'hidden' } })).toBe(true)
    expect(pageHidden({ document: { visibilityState: 'visible' } })).toBe(false)
    expect(pageHidden({})).toBe(false)
  })
})

describe('installPageResumeRecovery', () => {
  it('reconnects when the page comes back from hidden', () => {
    const win = makeWindow(false)
    let reconnects = 0
    const dispose = installPageResumeRecovery(win, { reconnect: () => { reconnects += 1 } })
    win.hidden = true
    fire(win, 'visibilitychange')
    expect(reconnects).toBe(0)
    win.hidden = false
    fire(win, 'visibilitychange')
    expect(reconnects).toBe(1)
    dispose()
  })

  it('does not reconnect for a tab that was never suspended', () => {
    const win = makeWindow(false)
    let reconnects = 0
    const dispose = installPageResumeRecovery(win, { reconnect: () => { reconnects += 1 } })
    fire(win, 'visibilitychange')
    fire(win, 'visibilitychange')
    expect(reconnects).toBe(0)
    dispose()
  })

  it('reconnects once per hidden period', () => {
    const win = makeWindow(false)
    let reconnects = 0
    const dispose = installPageResumeRecovery(win, { reconnect: () => { reconnects += 1 } })
    win.hidden = true
    fire(win, 'visibilitychange')
    win.hidden = false
    fire(win, 'visibilitychange')
    win.hidden = true
    fire(win, 'visibilitychange')
    win.hidden = false
    fire(win, 'visibilitychange')
    expect(reconnects).toBe(2)
    dispose()
  })

  it('survives a connection that cannot be reset', () => {
    const win = makeWindow(false)
    const dispose = installPageResumeRecovery(win, { reconnect: () => { throw new Error('gone') } })
    win.hidden = true
    fire(win, 'visibilitychange')
    win.hidden = false
    expect(() => fire(win, 'visibilitychange')).not.toThrow()
    dispose()
  })

  it('stops listening after dispose', () => {
    const win = makeWindow(false)
    let reconnects = 0
    const dispose = installPageResumeRecovery(win, { reconnect: () => { reconnects += 1 } })
    dispose()
    win.hidden = true
    fire(win, 'visibilitychange')
    win.hidden = false
    fire(win, 'visibilitychange')
    expect(reconnects).toBe(0)
  })

  it('is a no-op for a window without listeners', () => {
    expect(() => installPageResumeRecovery({}, { reconnect: () => undefined })()).not.toThrow()
  })
})
