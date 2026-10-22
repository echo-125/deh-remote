/**
 * Browser API polyfills for the official client's hard requirements.
 *
 * The official client uses two APIs that only reached Safari in 17.4:
 * `AbortSignal.any` (it fuses the generation and delivery signals) and
 * `Promise.withResolvers` (it builds the session control stream). On an
 * older WebKit the calls throw a TypeError inside the client's own
 * generation, so the transport is healthy and the page renders while the UI
 * sits in "Reconnecting" - or the control stream fails and the workspace
 * list stays empty.
 *
 * The implementations are the standard shapes. They install only when the
 * runtime lacks the API, and they are emitted into the parse-time boot
 * script so they are in place before any client code runs.
 *
 * @module @echo-125/deh-remote/browser-polyfills
 */

/** The polyfill source, as a script fragment. */
export const BROWSER_POLYFILL_SCRIPT = [
  'try{if(typeof AbortSignal!=="undefined"&&typeof AbortSignal.any!=="function"){AbortSignal.any=function (signals) {\n  var list = Array.prototype.slice.call(signals);\n  var ctl = new AbortController();\n  for (var i = 0; i < list.length; i += 1) {\n    var s = list[i];\n    if (!s) continue;\n    if (s.aborted) { ctl.abort(s.reason); break; }\n    s.addEventListener("abort", function () { ctl.abort(s.reason); }, { once: true });\n  }\n  return ctl.signal;\n}}}catch(e){}',
  'try{if(typeof Promise!=="undefined"&&typeof Promise.withResolvers!=="function"){Promise.withResolvers=function () {\n  var resolve, reject;\n  var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });\n  return { promise: promise, resolve: resolve, reject: reject };\n}}}catch(e){}',
].join('')

/**
 * The AbortSignal.any polyfill, as a standalone function.
 * @param signals - the signals to fuse.
 * @returns a signal that aborts when any of the given ones does.
 */
export function abortSignalAny(signals: AbortSignal[]): AbortSignal {
  const list = signals.slice()
  const controller = new AbortController()
  for (const signal of list) {
    if (signal === undefined) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => { controller.abort(signal.reason) }, { once: true })
  }
  return controller.signal
}

/** The handle Promise.withResolvers produces. */
export interface PromiseWithResolvers<T> {
  /** The promise the handle settles. */
  promise: Promise<T>
  /** Resolve the promise. */
  resolve: (value: T | PromiseLike<T>) => void
  /** Reject the promise. */
  reject: (reason?: unknown) => void
}

/**
 * The Promise.withResolvers polyfill, as a standalone function.
 * @returns the handle with the promise and its settlement functions.
 */
export function promiseWithResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
