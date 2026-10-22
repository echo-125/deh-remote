/**
 * Server-rendered diagnostics page for the remote channel.
 *
 * A phone has no DevTools, so the browser half cannot be inspected there; and
 * the official client opens its mux before any client plugin code runs, so a
 * browser-side probe can miss the very leg that matters. This page reads the
 * host-side trace (channel-log.ts) and renders it, so the answer is one
 * URL away on the device that is failing.
 *
 * It is read-only and carries no credential: the trace records the gate
 * outcome, the inner status and the survival time, never the device id.
 *
 * @module @echo-125/deh-remote/diag-page
 */

import { readChannelLog, type ChannelLegRecord } from './channel-log.ts'

/** Escape a value for HTML text content. */
function esc(value: string): string {
  // Built from character codes: the entity text itself must survive every
  // escaping layer intact, or the banner would inject markup.
  const amp = String.fromCharCode(38)
  const lt = String.fromCharCode(60)
  const gt = String.fromCharCode(62)
  const quot = String.fromCharCode(34)
  return value
    .split(amp).join(amp + amp)
    .split(lt).join(amp + 'lt;')
    .split(gt).join(amp + 'gt;')
    .split(quot).join(amp + 'quot;')
}

/** One trace row, rendered. */
function row(record: ChannelLegRecord): string {
  const at = new Date(record.at).toISOString().slice(11, 23)
  const held = record.heldMs === undefined ? '-' : String(record.heldMs) + 'ms'
  const inner = record.innerStatus === undefined ? '-' : String(record.innerStatus)
  return [
    '<tr><td>' + esc(at) + '</td><td>' + esc(record.path) + '</td>',
    '<td>' + esc(record.outcome) + '</td><td>' + esc(String(record.status)) + '</td>',
    '<td>' + esc(inner) + '</td><td>' + esc(held) + '</td></tr>',
  ].join('')
}

/**
 * Render the diagnostics page.
 * @param records - the traced legs, oldest first.
 * @returns the HTML document.
 */
export function renderDiagPage(records: ChannelLegRecord[]): string {
  const recent = records.slice(-40).reverse()
  const refused = records.filter((r) => r.outcome !== 'accepted').length
  const accepted = records.length - refused
  const innerRefused = records.filter((r) => r.innerStatus !== undefined && r.innerStatus !== 101).length
  const shortLived = records.filter(
    (r) => r.heldMs !== undefined && r.heldMs < 15000,
  ).length

  const summary = [
    ['总尝试', String(records.length)],
    ['网关放行', String(accepted)],
    ['网关拒绝', String(refused)],
    ['内环非 101', String(innerRefused)],
    ['15s 内断开', String(shortLived)],
  ]
    .map(([k, v]) => '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>')
    .join('')

  const rows = recent.length === 0
    ? '<tr><td colspan="6">暂无记录</td></tr>'
    : recent.map(row).join('')

  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>远程通道诊断</title>',
    '<style>',
    'body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#0f1115;color:#e6e6e6;}',
    'h1{font-size:16px;margin:0 0 12px;}',
    '.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 12px;margin-bottom:16px;font-size:13px;}',
    '.k{opacity:.65}.v{text-align:right;font-variant-numeric:tabular-nums}',
    'table{width:100%;border-collapse:collapse;font-size:11px;}',
    'th,td{border-bottom:1px solid #2a2f38;padding:5px 4px;text-align:left;}',
    'th{opacity:.6;font-weight:600;}',
    '.hint{margin-top:14px;font-size:12px;opacity:.6;line-height:1.6;}',
    '</style></head><body>',
    '<h1>远程通道诊断 / Remote channel diagnostics</h1>',
    '<div class="grid">' + summary + '</div>',
    '<table><thead><tr><th>时间</th><th>路径</th><th>结果</th><th>外层</th><th>内环</th><th>存活</th></tr></thead>',
    '<tbody>' + rows + '</tbody></table>',
    '<p class="hint">刷新本页可看到最新尝试。内环列显示 127.0.0.1 那条腿的握手状态；',
    '101 表示成功，401/403 表示内环拒绝。存活列小于 15000ms 表示连接建立后立刻被拆。</p>',
    '</body></html>',
  ].join('')
}

/**
 * Inject a server-rendered diagnostic banner into the app shell.
 *
 * The banner is inserted right after the opening <head> so it is visible on
 * the phone without any interaction. It reports the recent mux legs of the
 * channel, which is the only signal that separates "the phone never asked"
 * from "the gateway refused" from "the inner leg refused" from "the leg was
 * accepted and then torn down".
 *
 * @param html - the patched shell document.
 * @param records - the traced legs, oldest first.
 * @returns the document with the banner prepended to the head.
 */
export function injectDiagBanner(html: string, records: ChannelLegRecord[]): string {
  const recent = records.slice(-8).reverse()
  const refused = records.filter((r) => r.outcome !== 'accepted').length
  const innerRefused = records.filter((r) => r.innerStatus !== undefined && r.innerStatus !== 101).length
  const shortLived = records.filter((r) => r.heldMs !== undefined && r.heldMs < 15000).length
  const lines = recent.map((r) => {
    const at = new Date(r.at).toISOString().slice(11, 19)
    const inner = r.innerStatus === undefined ? '-' : String(r.innerStatus)
    const held = r.heldMs === undefined ? '-' : String(r.heldMs) + 'ms'
    // The path is the decisive field: it tells whether the phone asked for
    // the rewritten gateway path or the raw one.
    return esc(at) + ' ' + esc(r.path) + ' ' + esc(r.outcome) +
      ' 外层' + esc(String(r.status)) + ' 内环' + esc(inner) + ' 存活' + esc(held)
  })
  const banner = [
    '<div id="dsh-remote-diag" style="position:fixed;left:0;right:0;top:0;z-index:99999;',
    'background:#111;color:#eee;font:11px/1.5 ui-monospace,Menlo,monospace;padding:6px 8px;',
    'max-height:34vh;overflow:auto;border-bottom:1px solid #444">',
    '<b>远程通道诊断</b> 总' + esc(String(records.length)) + ' 放行' + esc(String(records.length - refused)) +
      ' 拒绝' + esc(String(refused)) + ' 内环非101' + esc(String(innerRefused)) + ' 15s内断' + esc(String(shortLived)),
    '<br>完整诊断页：/pair-diag',
    lines.length === 0 ? '<br>（暂无 mux 记录）' : lines.map((l) => '<br>' + l).join(''),
    '</div>',
  ].join('')
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) return banner + html
  const end = head.index + head[0].length
  return html.slice(0, end) + banner + html.slice(end)
}
