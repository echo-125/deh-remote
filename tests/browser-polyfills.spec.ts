/**
 * Browser API polyfill tests.
 *
 * The official client uses two APIs that only reached Safari in 17.4:
 * `AbortSignal.any` (it fuses the generation and delivery signals) and
 * `Promise.withResolvers` (it builds the session control stream). On an older
 * WebKit the calls throw a TypeError inside the client's own generation: the
 * transport is healthy, the page renders, and the UI sits in "Reconnecting"
 * - or the control stream fails and the workspace list stays empty.
 */
import { describe, expect, it } from 'vitest'

import { abortSignalAny, BROWSER_POLYFILL_SCRIPT, promiseWithResolvers } from '../src/browser-polyfills.ts'
import { buildRemoteChannelBootScript } from '../src/remote-channel-boot.ts'

describe('AbortSignal.any polyfill', () => {
  it('aborts when one of the fused signals aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const fused = abortSignalAny([a.signal, b.signal])
    expect(fused.aborted).toBe(false)
    b.abort('why')
    expect(fused.aborted).toBe(true)
    expect(fused.reason).toBe('why')
  })

  it('is already aborted when a fused signal is already aborted', () => {
    const a = new AbortController()
    a.abort('earlier')
    const fused = abortSignalAny([a.signal, new AbortController().signal])
    expect(fused.aborted).toBe(true)
    expect(fused.reason).toBe('earlier')
  })

  it('tolerates an empty list', () => {
    expect(abortSignalAny([]).aborted).toBe(false)
  })
})

describe('Promise.withResolvers polyfill', () => {
  it('produces a promise the handle resolves', async () => {
    const handle = promiseWithResolvers<string>()
    handle.resolve('done')
    await expect(handle.promise).resolves.toBe('done')
  })

  it('produces a promise the handle rejects', async () => {
    const handle = promiseWithResolvers<string>()
    handle.reject(new Error('nope'))
    await expect(handle.promise).rejects.toThrow('nope')
  })
})

describe('the polyfill script', () => {
  it('installs both polyfills when the runtime lacks them', () => {
    expect(BROWSER_POLYFILL_SCRIPT).toContain('AbortSignal.any=function (signals)')
    expect(BROWSER_POLYFILL_SCRIPT).toContain('Promise.withResolvers=function ()')
  })

  it('runs in a context without the modern APIs', () => {
    const ShimPromise = Promise as unknown as { withResolvers?: unknown }
    const ShimAbort = AbortSignal as unknown as { any?: unknown }
    delete ShimPromise.withResolvers
    delete ShimAbort.any
    const run = new Function('Promise', 'AbortSignal', BROWSER_POLYFILL_SCRIPT)
    run(ShimPromise, ShimAbort)
    expect(typeof ShimAbort.any).toBe('function')
    expect(typeof ShimPromise.withResolvers).toBe('function')
  })

  it('is part of the boot script, before the early returns', () => {
    const script = buildRemoteChannelBootScript()
    expect(script).toContain('AbortSignal.any=function (signals)')
    expect(script).toContain('Promise.withResolvers=function ()')
    // The polyfill must come before the loopback early return, or a
    // loopback page would keep the gap.
    expect(script.indexOf('AbortSignal.any=function')).toBeLessThan(script.indexOf('localhost'))
  })
})
