/**
 * Channel trace arming tests.
 *
 * The trace exists to explain a failing connection. A working one needs none
 * of it, so an unarmed instance must write nothing at all - the trace has to
 * cost a paired phone nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendChannelLog,
  channelLogArmed,
  readChannelLog,
  setChannelLogArmed,
} from '../src/channel-log.ts'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'deh-remote-arm-'))
}

afterEach(() => {
  setChannelLogArmed(false)
})

describe('the channel trace arming', () => {
  it('is disarmed by default', () => {
    expect(channelLogArmed()).toBe(false)
  })

  it('writes nothing while disarmed', () => {
    const h = home()
    appendChannelLog({ at: 1, path: '/x', credentialed: true, outcome: 'accepted', status: 101 }, { home: h })
    expect(readChannelLog({ home: h })).toEqual([])
  })

  it('writes once armed', () => {
    const h = home()
    setChannelLogArmed(true)
    appendChannelLog({ at: 1, path: '/x', credentialed: true, outcome: 'accepted', status: 101 }, { home: h })
    expect(readChannelLog({ home: h })).toHaveLength(1)
  })

  it('stops writing when disarmed again', () => {
    const h = home()
    setChannelLogArmed(true)
    appendChannelLog({ at: 1, path: '/x', credentialed: false, outcome: 'accepted', status: 101 }, { home: h })
    setChannelLogArmed(false)
    appendChannelLog({ at: 2, path: '/y', credentialed: false, outcome: 'accepted', status: 101 }, { home: h })
    const records = readChannelLog({ home: h })
    expect(records).toHaveLength(1)
    expect(records[0]?.at).toBe(1)
  })

  it('lets an explicit override write while disarmed', () => {
    const h = home()
    appendChannelLog({ at: 1, path: '/x', credentialed: false, outcome: 'accepted', status: 101 }, { home: h, armed: true })
    expect(readChannelLog({ home: h })).toHaveLength(1)
  })
})
