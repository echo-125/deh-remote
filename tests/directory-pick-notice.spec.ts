/**
 * Directory-pick feedback tests.
 *
 * The host resolves its directory-picker backend once per boot from the
 * host's own facts, so a loopback-bound host picks the native interaction -
 * and the native surface is renderless: it calls the OS chooser and waits.
 * On a phone that means the desktop pops a dialog while the phone shows
 * nothing, so a pending pick is indistinguishable from a broken button.
 */
import { describe, expect, it, vi } from 'vitest'

import { trackPickPending } from '../src/client/DirectoryPickNotice.tsx'

describe('trackPickPending', () => {
  it('reports no pending pick before one starts', () => {
    const tracker = trackPickPending(async () => 'path')
    expect(tracker.pending()).toBe(false)
  })

  it('is pending while the host is still answering', async () => {
    let release: (value: string) => void = () => undefined
    const tracker = trackPickPending(() => new Promise<string>((resolve) => { release = resolve }))
    const inFlight = tracker.call()
    expect(tracker.pending()).toBe(true)
    release('chosen')
    await expect(inFlight).resolves.toBe('chosen')
    expect(tracker.pending()).toBe(false)
  })

  it('is pending while the host is still answering, and notifies its listeners', async () => {
    let release: (value: string) => void = () => undefined
    const tracker = trackPickPending(() => new Promise<string>((resolve) => { release = resolve }))
    const seen: boolean[] = []
    const unsubscribe = tracker.subscribe(() => { seen.push(tracker.pending()) })
    const inFlight = tracker.call()
    expect(seen).toEqual([true])
    release('chosen')
    await inFlight
    expect(seen).toEqual([true, false])
    unsubscribe()
  })

  it('clears the pending state when the host refuses', async () => {
    const tracker = trackPickPending(async () => { throw new Error('refused') })
    await expect(tracker.call()).rejects.toThrow('refused')
    expect(tracker.pending()).toBe(false)
  })

  it('counts concurrent picks', async () => {
    const releases: Array<(value: string) => void> = []
    const tracker = trackPickPending(() => new Promise<string>((resolve) => { releases.push(resolve) }))
    const first = tracker.call()
    const second = tracker.call()
    expect(tracker.pending()).toBe(true)
    // Releasing one pick must leave the other pending.
    releases[0]?.('chosen')
    await first
    expect(tracker.pending()).toBe(true)
    releases[1]?.('chosen')
    await second
    expect(tracker.pending()).toBe(false)
  })

  it('stops notifying after unsubscribe', async () => {
    const tracker = trackPickPending(async () => 'path')
    const listener = vi.fn()
    const unsubscribe = tracker.subscribe(listener)
    unsubscribe()
    await tracker.call()
    expect(listener).not.toHaveBeenCalled()
  })
})
