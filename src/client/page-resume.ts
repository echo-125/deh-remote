/**
 * Page-resume recovery for the remote channel.
 *
 * A phone browser suspends a background tab: iOS Safari and Chrome both
 * close the tab's WebSockets, and iOS reports it as close code 1001 with the
 * reason "WebSocket is closed due to suspension". The official client does
 * not listen for the resume events, so it only rediscovers the lost socket
 * through its retry backoff - up to ten seconds of "Reconnecting" before the
 * channel comes back, and a reconnect that starts while the page is still
 * suspended fails the same way.
 *
 * This module closes that gap: when the page becomes visible again, the
 * connection is asked to replace its current attempt immediately instead of
 * waiting out the backoff. It is a no-op on a desktop tab that was never
 * suspended, and it never touches the channel beyond that one call.
 *
 * @module @echo-125/deh-remote/page-resume

/** The connection surface this module drives. */
export interface ResumableConnection {
  /** Replace the current attempt immediately (the official API). */
  reconnect(): void
}

/** The window surface this module observes. */
export interface ResumeWindow {
  /** Whether the document is currently hidden. */
  readonly hidden?: boolean
  /** The document object, when the window carries one. */
  readonly document?: { visibilityState?: string }
  /** Register a visibility listener. */
  addEventListener?: (type: string, listener: () => void) => void
  /** Remove a visibility listener. */
  removeEventListener?: (type: string, listener: () => void) => void
}

/**
 * Whether the page is currently hidden.
 * @param win - the window to inspect.
 * @returns true when the document is hidden.
 */
export function pageHidden(win: ResumeWindow): boolean {
  if (typeof win.hidden === 'boolean') return win.hidden
  return win.document?.visibilityState === 'hidden'
}

/**
 * Install the resume recovery.
 *
 * The recovery fires when the page becomes visible again after having been
 * hidden, and only then: a page that was never suspended must not churn the
 * connection. The reconnect is requested at most once per hidden period.
 * @param win - the window to observe.
 * @param connection - the connection to reset.
 * @returns a disposer removing the listener.
 */
export function installPageResumeRecovery(win: ResumeWindow, connection: ResumableConnection): () => void {
  if (win.addEventListener === undefined) return () => undefined
  let wasHidden = pageHidden(win)
  const onVisibility = (): void => {
    const hidden = pageHidden(win)
    // Only the hidden -> visible edge asks for a new attempt: a page that
    // was never suspended keeps the connection it has.
    if (hidden || !wasHidden) {
      wasHidden = hidden
      return
    }
    wasHidden = hidden
    try {
      connection.reconnect()
    } catch {
      // A connection that is already gone has nothing to reset.
    }
  }
  win.addEventListener('visibilitychange', onVisibility)
  return () => {
    win.removeEventListener?.('visibilitychange', onVisibility)
  }
}
