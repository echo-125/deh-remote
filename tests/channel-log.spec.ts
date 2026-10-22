/**
 * Channel trace tests: the trace is the only way to read the mux leg on a
 * phone, so it must record the decisive facts (gate outcome, inner status,
 * survival time) and must never record a credential.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { appendChannelLog, CHANNEL_LOG_FILE, MAX_CHANNEL_LOG_RECORDS, readChannelLog } from '../src/channel-log.ts'
import { injectDiagBanner, renderDiagPage } from '../src/diag-page.ts'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'deh-remote-diag-'))
}

describe('channel log', () => {
  it('records a leg and reads it back', () => {
    const h = home()
    appendChannelLog({ at: 1, path: '/remote/api/remote.mux', credentialed: true, outcome: 'accepted', status: 101, innerStatus: 101, heldMs: 4200 }, { home: h })
    const records = readChannelLog({ home: h })
    expect(records).toHaveLength(1)
    expect(records[0]?.innerStatus).toBe(101)
    expect(records[0]?.heldMs).toBe(4200)
  })

  it('keeps the trace bounded', () => {
    const h = home()
    for (let i = 0; i < MAX_CHANNEL_LOG_RECORDS + 25; i += 1) {
      appendChannelLog({ at: i, path: '/x', credentialed: false, outcome: 'accepted', status: 101 }, { home: h })
    }
    const records = readChannelLog({ home: h })
    expect(records.length).toBe(MAX_CHANNEL_LOG_RECORDS)
    // The newest record is kept.
    expect(records[records.length - 1]?.at).toBe(MAX_CHANNEL_LOG_RECORDS + 24)
  })

  it('never stores a device credential in the record', () => {
    const h = home()
    appendChannelLog({ at: 1, path: '/remote/api/remote.mux', credentialed: true, outcome: 'accepted', status: 101 }, { home: h })
    const raw = readFileSync(join(h, CHANNEL_LOG_FILE), 'utf8')
    expect(raw).not.toMatch(/dsh_pair/)
    expect(raw).not.toMatch(/device=/)
  })

  it('tolerates a missing or damaged trace file', () => {
    const h = home()
    expect(readChannelLog({ home: h })).toEqual([])
    writeFileSync(join(h, CHANNEL_LOG_FILE), 'not json', 'utf8')
    expect(readChannelLog({ home: h })).toEqual([])
  })

  it('does not throw when the home directory cannot be written', () => {
    const h = join(home(), 'nested', 'deeper')
    appendChannelLog({ at: 1, path: '/x', credentialed: false, outcome: 'accepted', status: 101 }, { home: h })
    expect(readChannelLog({ home: h }).length).toBe(1)
  })
})

describe('diagnostics page', () => {
  it('renders the summary counters and the recent legs', () => {
    const html = renderDiagPage([
      { at: Date.now(), path: '/remote/api/remote.mux', credentialed: true, outcome: 'accepted', status: 101, innerStatus: 101, heldMs: 5000 },
      { at: Date.now(), path: '/remote/api/remote.mux', credentialed: false, outcome: 'unpaired', status: 403 },
    ])
    expect(html).toContain('远程通道诊断')
    expect(html).toContain('内环非 101')
    expect(html).toContain('remote.mux')
  })

  it('renders an empty trace without throwing', () => {
    const html = renderDiagPage([])
    expect(html).toContain('暂无记录')
  })

  it('injects the banner into the shell head', () => {
    const html = injectDiagBanner('<!doctype html><html><head><title>x</title></head><body></body></html>', [
      { at: Date.now(), path: '/remote/api/remote.mux', credentialed: true, outcome: 'accepted', status: 101, innerStatus: 101 },
    ])
    expect(html.indexOf('dsh-remote-diag')).toBeGreaterThan(-1)
    expect(html.indexOf('dsh-remote-diag')).toBeLessThan(html.indexOf('<title>'))
  })

  it('escapes hostile content in the banner', () => {
    const html = injectDiagBanner('<html><head></head></html>', [
      { at: Date.now(), path: '<script>alert(1)</script>', credentialed: true, outcome: 'accepted', status: 101 },
    ])
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
