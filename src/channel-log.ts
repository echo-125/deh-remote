/**
 * Host-side channel log: a bounded, file-backed trace of the remote
 * channel's WebSocket legs.
 *
 * Why this exists: the browser half cannot be observed on a phone (no
 * DevTools, and the official client opens its mux before any client plugin
 * code runs, so a browser-side probe can miss the very leg that matters).
 * The gateway, in contrast, sees every upgrade attempt and knows the answer
 * before the socket is handed on: which path was asked for, whether the
 * device credential was accepted, what the inner leg answered, and how long
 * the leg survived.
 *
 * The package may not print to the host console, so the trace goes to a file
 * under the DSH home instead. It is opt-in (armed through the same query
 * flag the browser half uses) and bounded in both size and age, and it never
 * records a credential.
 *
 * @module @echo-125/deh-remote/channel-log
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'

/** One recorded upgrade attempt. */
export interface ChannelLegRecord {
  /** Epoch ms when the attempt was seen. */
  at: number
  /** The outer path the browser asked for. */
  path: string
  /** Whether the request carried a device credential (cookie or query). */
  credentialed: boolean
  /** The gate outcome: 'accepted' | 'unpaired' | 'port-unbound' | 'denied'. */
  outcome: string
  /** The HTTP status the outer leg answered with (101 on success). */
  status: number
  /** The status the inner (loopback) leg answered with, when it was observed. */
  innerStatus?: number
  /** Milliseconds the leg survived; undefined while it is open. */
  heldMs?: number
  /** Close code observed on the leg. */
  code?: number
}

/** Maximum records kept in the trace file. */
export const MAX_CHANNEL_LOG_RECORDS = 200

/**
 * Whether the trace is armed.
 *
 * The tunnel records from deep inside the proxy, so the gate cannot be a
 * parameter on every call: an unarmed instance simply writes nothing.
 */
let armed = false

/**
 * Arm or disarm the trace.
 *
 * @param value - whether records should be written.
 */
export function setChannelLogArmed(value: boolean): void {
  armed = value
}

/**
 * Whether the trace is armed.
 *
 * @returns true when records are written.
 */
export function channelLogArmed(): boolean {
  return armed
}

/** The file name under the DSH home. */
export const CHANNEL_LOG_FILE = 'remote-channel-log.json'

/** Options for the log sink. */
export interface ChannelLogOptions {
  /** Home directory seam (tests). */
  home?: string
  /** Clock seam (tests). */
  now?: () => number
  /** Write regardless of the arm switch (tests and the explicit opt-in). */
  armed?: boolean
}

/**
 * Append one record to the trace file, keeping it bounded.
 * @param record - the leg to record.
 * @param options - home/clock seams.
 * @returns the absolute file path, or undefined when the write failed.
 */
export function appendChannelLog(record: ChannelLegRecord, options: ChannelLogOptions = {}): string | undefined {
  // An unarmed instance writes nothing: the trace is diagnostic, and a paired
  // phone must not pay for I/O it never asked for.
  if (!armed && options.armed !== true) return undefined
  const home = options.home ?? dshHome()
  const file = join(home, CHANNEL_LOG_FILE)
  try {
    mkdirSync(home, { recursive: true })
    // One record per line, appended: a read-modify-write of the whole file
    // loses records when two connections report at the same time, and the
    // trace has to be trustworthy exactly when several legs are alive.
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
    return file
  } catch {
    // The trace is diagnostic only: a failed write must never affect the
    // channel itself.
    return undefined
  }
}

/**
 * Read the recorded legs.
 * @param options - home seam.
 * @returns the records, oldest first; empty when the file is missing.
 */
export function readChannelLog(options: ChannelLogOptions = {}): ChannelLegRecord[] {
  const home = options.home ?? dshHome()
  return readRecords(join(home, CHANNEL_LOG_FILE))
}

/**
 * Read and parse the trace file, tolerating a missing or damaged file.
 * @param file - the absolute path.
 * @returns the records, oldest first.
 */
function readRecords(file: string): ChannelLegRecord[] {
  try {
    if (statSync(file).size === 0) return []
    const records: ChannelLegRecord[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (typeof parsed === 'object' && parsed !== null && typeof (parsed as ChannelLegRecord).at === 'number') {
          records.push(parsed as ChannelLegRecord)
        }
      } catch {
        // A torn line is skipped: the trace is best-effort by design.
      }
    }
    return records.slice(-MAX_CHANNEL_LOG_RECORDS)
  } catch {
    return []
  }
}
