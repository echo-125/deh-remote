/**
 * On-page diagnostics overlay for the remote channel (opt-in).
 *
 * Renders the {@link installDiagProbe} snapshot as a small dismissible card.
 * It exists because this package may not log to the host console: the only
 * places a technician can read mux-leg facts on a phone are the page itself
 * and a serialised global, so the overlay is the readable one.
 *
 * The card is read-only: it never retries, re-pairs or mutates channel state,
 * so it cannot mask or cause the failure it reports.
 */
import { useEffect, useState } from 'react'
import type { RemoteDiagSnapshot } from './diag-probe.ts'
import css from './remote.module.css'

/** Overlay props. */
export interface DiagPanelProps {
  /** Snapshot reader from the installed probe. */
  read: () => RemoteDiagSnapshot
  /** Poll interval in ms (default 1000). */
  intervalMs?: number
  /** Dismiss handler (hides the card, leaves the probe armed). */
  onDismiss: () => void
}

const okClass = (good: boolean): string => (good ? css.diagOk : css.diagBad)

/**
 * Render the diagnostics overlay.
 * @param props - snapshot reader, poll interval and dismiss handler.
 * @returns the overlay element.
 */
export function DiagPanel({ read, intervalMs = 1000, onDismiss }: DiagPanelProps) {
  const [snap, setSnap] = useState<RemoteDiagSnapshot | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [showText, setShowText] = useState(false)

  useEffect(() => {
    const tick = (): void => {
      try {
        setSnap(read())
      } catch {
        // A torn-down probe: keep the last good snapshot on screen.
      }
    }
    tick()
    const timer = setInterval(tick, intervalMs)
    return () => {
      clearInterval(timer)
    }
  }, [read, intervalMs])

  if (snap === undefined) return null
  const legs = snap.legs.slice(-6)
  const copy = JSON.stringify(snap)

  return (
    <aside className={css.diagPage} data-dsh-plugin="remote-web-ui" aria-label="remote diagnostics">
      <h2 className={css.diagTitle}>远程通道诊断</h2>

      <div className={css.diagRow}>
        <span className={css.diagKey}>页面来源</span>
        <span className={css.diagVal}>{snap.origin.hostname}</span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>回环 / 安全上下文</span>
        <span className={css.diagVal}>{String(snap.origin.isLoopback)} / {String(snap.origin.secure)}</span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>改写座位 / 主机授权</span>
        <span className={`${css.diagVal} ${okClass(snap.seatInstalled && snap.hostGranted)}`}>
          {String(snap.seatInstalled)} / {String(snap.hostGranted)}
        </span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>设备凭据</span>
        <span className={`${css.diagVal} ${okClass(snap.devicePresent)}`}>{String(snap.devicePresent)}</span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>REST 状态分布</span>
        <span className={css.diagVal}>{JSON.stringify(snap.rest)}</span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>rpc.open（走 mux 还是 transport）</span>
        <span className={css.diagVal}>{String(snap.hasRpcOpen)}</span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>交互模式 / 有 location</span>
        <span className={css.diagVal}>
          {String(snap.interactions ?? '?')} / {String(snap.hasLocation)}
        </span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>连接状态 / 代号</span>
        <span className={css.diagVal}>
          {String(snap.connectionState ?? '?')} / {String(snap.generationId ?? '-')}
        </span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>transport 键</span>
        <span className={css.diagVal}>{snap.transportKeys.join(',') || '(none)'}</span>
      </div>
      <div className={css.diagRow}>
        <span className={css.diagKey}>openStream / createWebSocket</span>
        <span className={css.diagVal}>
          {String(snap.transportHasOpenStream)} / {String(snap.transportHasCreateWebSocket)}
        </span>
      </div>

      <p className={css.diagSub}>事件流 (mux) 连接</p>
      {legs.length === 0
        ? <p className={css.diagEmpty}>尚未观察到 mux 连接</p>
        : (
          <ol className={css.diagList}>
            {legs.map((leg, index) => (
              <li key={leg.at + "-" + String(index)}>
                <span className={okClass(leg.outcome === "open" && (leg.heldMs ?? 0) > 15000)}>{leg.outcome}</span>
                {" · "}{leg.url.replace(/^ws?:\/\/[^/]+/, "")}
                {" · device "}{String(leg.hasDeviceQuery)}
                {" · 帧 "}{String(leg.frames)}
                {leg.heldMs !== undefined ? " · 存活 " + String(leg.heldMs) + "ms" : " · 仍开放"}
                {leg.code !== undefined ? " · code " + String(leg.code) : ""}
              </li>
            ))}
          </ol>
        )}
      {snap.logs.length > 0 && (
        <>
          <p className={css.diagSub}>官方客户端日志</p>
          <ol className={css.diagList}>
            {snap.logs.map((entry, index) => (
              <li key={String(index)}>{entry}</li>
            ))}
          </ol>
        </>
      )}
      {snap.shortLived > 0 && (
        <p className={css.diagBad}>{snap.shortLived} 条连接在就绪窗口内被关闭</p>
      )}

      {showText && (
        <textarea
          className={css.diagText}
          readOnly
          value={copy}
          onFocus={(event) => { event.currentTarget.select() }}
          rows={6}
          aria-label="diagnostics text"
        />
      )}
      <div className={css.diagActions}>
        <button
          className={css.diagButton}
          type="button"
          onClick={() => {
            // The async clipboard API needs a secure context, and a paired
            // phone reaches the landing over plain HTTP - so the copy falls
            // back to a selection the technician can copy by hand.
            if (navigator.clipboard !== undefined) {
              void navigator.clipboard.writeText(copy).then(
                () => { setCopied(true) },
                () => { setCopied(true); setShowText(true) },
              )
              return
            }
            setShowText(true)
          }}
        >
          {copied ? "已复制" : "复制诊断"}
        </button>
        <button className={css.diagButton} type="button" onClick={onDismiss}>关闭</button>
      </div>
    </aside>
  )
}
