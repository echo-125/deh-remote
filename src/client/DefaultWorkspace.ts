/**
 * The default workspace as a phone-side choice.
 *
 * The host resolves its directory-picker backend once per boot, from the
 * host's own bind and trust facts - it does not know a remote client is
 * attached, so a loopback-bound host picks the native interaction. The native
 * surface is renderless: it calls the OS chooser on the desktop and waits.
 * On a phone that means the desktop pops a dialog while the phone shows
 * nothing, and the operator cannot pick anything from the phone at all.
 *
 * The default workspace has no such problem: the host resolves it itself
 * (the account's Documents directory plus a fixed leaf), and the Workspace
 * controller exposes it as a Remote method the phone can call directly. So a
 * phone that asks for a directory gets the default workspace instead of a
 * chooser it cannot operate - the same answer the desktop would have produced
 * on first use.
 *
 * @module @echo-125/deh-remote/client/DefaultWorkspace

/** The leaf name the host registers the first-use workspace under. */
export const DEFAULT_WORKSPACE_TITLE = "default-workspace"

/** The workspace projection the host returns. */
export interface WorkspaceProjection {
  /** The workspace id the host registered it under. */
  workspaceId: string
  /** The canonical host directory it owns. */
  path: string
  /** The stored title (the default leaf name, which the UI labels per language). */
  title: string
}

/** The Workspace controller the browser half exposes. */
export interface WorkspaceController {
  /**
   * Initialize (or reuse) the default workspace and merge its row into the
   * local projection.
   * @param signal - caller lifetime.
   * @returns the workspace, or undefined when the host declined.
   */
  initializeDefault?: (signal?: AbortSignal) => Promise<WorkspaceProjection | undefined>
  /** The known workspaces. */
  list?: { getSnapshot?: () => { items?: WorkspaceProjection[] } }
}

/**
 * The default workspace among the known ones.
 *
 * The host registers it under a fixed leaf name and the browser labels that
 * title in the reader language, so the default is recognized by its title.
 * @param workspaces - the known workspaces.
 * @returns the default workspace, or undefined when there is none.
 */
export function defaultWorkspaceOf(
  workspaces: WorkspaceProjection[] | undefined,
): WorkspaceProjection | undefined {
  if (workspaces === undefined) return undefined
  return workspaces.find((workspace) => workspace.title === DEFAULT_WORKSPACE_TITLE)
}

/**
 * Resolve the default workspace through the host.
 *
 * The host owns the directory choice here: it resolves the account Documents
 * directory and a fixed leaf, so the phone never has to operate a desktop
 * file dialog. `undefined` means the host declined - the default is only
 * created on first use, so an installation that already has workspaces keeps
 * them.
 * @param controller - the Workspace controller.
 * @param signal - caller lifetime.
 * @returns the default workspace, or undefined when the host declined.
 */
export async function resolveDefaultWorkspace(
  controller: WorkspaceController | undefined,
  signal?: AbortSignal,
): Promise<WorkspaceProjection | undefined> {
  if (controller === undefined || typeof controller.initializeDefault !== "function") return undefined
  try {
    return await controller.initializeDefault(signal)
  } catch {
    // A refused or failed default is the host saying "not now" - the caller
    // falls back to the desktop chooser rather than failing outright.
    return undefined
  }
}
