/**
 * Default-workspace tests.
 *
 * A phone cannot operate a desktop file dialog, and a conversation without
 * a folder of its own lands in "Ungrouped". Both are answered by the
 * default workspace the host resolves itself.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_WORKSPACE_TITLE,
  defaultWorkspaceOf,
  resolveDefaultWorkspace,
  type WorkspaceProjection,
} from '../src/client/DefaultWorkspace.ts'

function workspace(title: string, workspaceId = title): WorkspaceProjection {
  return { workspaceId, path: 'C:/docs/' + title, title }
}

describe('defaultWorkspaceOf', () => {
  it('finds the workspace the host registered under the default leaf', () => {
    const found = defaultWorkspaceOf([workspace('other'), workspace(DEFAULT_WORKSPACE_TITLE, 'w2')])
    expect(found?.workspaceId).toBe('w2')
  })

  it('returns nothing when there is no default', () => {
    expect(defaultWorkspaceOf([workspace('other')])).toBeUndefined()
  })

  it('tolerates an empty or missing list', () => {
    expect(defaultWorkspaceOf([])).toBeUndefined()
    expect(defaultWorkspaceOf(undefined)).toBeUndefined()
  })
})

describe('resolveDefaultWorkspace', () => {
  it('asks the host and returns its workspace', async () => {
    const controller = {
      initializeDefault: vi.fn(async () => workspace(DEFAULT_WORKSPACE_TITLE, 'w1')),
    }
    const result = await resolveDefaultWorkspace(controller)
    expect(result?.workspaceId).toBe('w1')
    expect(controller.initializeDefault).toHaveBeenCalled()
  })

  it('returns nothing when the host declines', async () => {
    const controller = { initializeDefault: vi.fn(async () => undefined) }
    expect(await resolveDefaultWorkspace(controller)).toBeUndefined()
  })

  it('returns nothing when the host refuses', async () => {
    const controller = {
      initializeDefault: vi.fn(async () => { throw new Error('refused') }),
    }
    expect(await resolveDefaultWorkspace(controller)).toBeUndefined()
  })

  it('returns nothing without a controller', async () => {
    expect(await resolveDefaultWorkspace(undefined)).toBeUndefined()
    expect(await resolveDefaultWorkspace({})).toBeUndefined()
  })
})
