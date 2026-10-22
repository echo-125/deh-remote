/**
 * Visible feedback for a directory pick that waits on the host.
 *
 * The host resolves its directory-picker backend once per boot, from the
 * host's own bind and trust facts - not from who is connected. A host bound
 * to loopback therefore picks the native interaction, and the native surface
 * is renderless: it calls the OS chooser and waits. On a phone that means
 * the desktop pops a dialog while the phone shows nothing at all, so the
 * operator cannot tell a pending pick from a broken button.
 *
 * This notice closes that gap: while a pick is in flight, the phone says
 * that the choice happens on the desktop. It is a presentation layer over
 * the official call - the call itself is untouched.
 */
import { useEffect, useState } from 'react'
import css from './remote.module.css'

/** The translator the notice uses. */
export type PickNoticeTranslate = (key: 'pick.onDesktop') => string

/** Notice props. */
export interface DirectoryPickNoticeProps {
  /** Localized copy. */
  t: PickNoticeTranslate
  /** Whether a pick is currently in flight. */
  pending: boolean
}

/**
 * Render the pending-pick notice.
 * @param props - localized copy and the pending flag.
 * @returns the notice element, or null when no pick is in flight.
 */
export function DirectoryPickNotice({ t, pending }: DirectoryPickNoticeProps) {
  if (!pending) return null
  return (
    <div className={css.pickNotice} role="status" aria-live="polite" data-dsh-plugin="remote-web-ui">
      <span className={css.pickNoticeSpinner} aria-hidden="true" />
      <span className={css.pickNoticeText}>{t('pick.onDesktop')}</span>
    </div>
  )
}

/** The pick tracker the notice reads. */
export interface PickTracker {
  /** Whether a pick is currently in flight. */
  pending: () => boolean
  /** Subscribe to pending changes; returns an unsubscriber. */
  subscribe: (listener: () => void) => () => void
  /** The wrapped call to install in place of the official one. */
  call: () => Promise<unknown>
}

/**
 * Observe whether a directory pick is in flight.
 *
 * The pick is wrapped rather than the state polled: the official call is the
 * only place that knows when the host started and finished answering, and
 * wrapping it keeps the official surface untouched.
 * @param pick - the official pick call.
 * @returns the tracker.
 */
export function trackPickPending(pick: () => Promise<unknown>): PickTracker {
  let inFlight = 0
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    pending: () => inFlight > 0,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    call: async () => {
      inFlight += 1
      notify()
      try {
        return await pick()
      } finally {
        inFlight -= 1
        notify()
      }
    },
  }
}
