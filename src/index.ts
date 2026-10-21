/**
 * LAN-only remote control for the dsh web GUI — host half. Mounts the pairing
 * service (one-time tokens, device sessions, revocation), the /api/pair
 * route family (issue/accept/stop/heartbeat/status/events), the api/gate
 * listener that enforces pairing on every other /api request from
 * non-loopback hosts, and the presence sweep. The browser half (the
 * `./client` entry) renders the sidebar entry, the pairing panel, and the
 * phone-side pair/accept + deep-link flow.
 *
 * Reachability is local-area network only. The host web server keeps its own
 * loopback listener; `src/lan-forward.ts` serves this machine's LAN IPv4
 * address on the same port and forwards to that loopback listener. There is
 * deliberately no public-access path: no tunnel, no relay, no public base URL.
 */

import { join } from 'node:path'
import { setInterval as nodeSetInterval, setTimeout as nodeSetTimeout } from 'node:timers'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: pulls the host-side Context merge (ctx.connection, whose
// authenticatedUrl the /pair-accept redirect consumes).
import type {} from '@deepseek-ai/dsh-client-connection'
import { DEFAULT_IDLE_EXPIRE_MS, PairingService, type PairingConfig } from './pairing.ts'
import { dshHome } from './dsh-home.ts'
import { isPairedDeviceRequest, makeGateListener } from './gate.ts'
import { RemoteWebUiPairing } from './pairing-access.ts'
import { isTrustedApiRequest, makeRoutes } from './routes.ts'
import { makeRemoteApiRoutes, makeRemoteApiUpgradeRoutes } from './remote-api.ts'
import { lanIPv4Addresses } from './lan.ts'
import { ensureFirewallRule, firewallSummary, removeFirewallRule, type FirewallSummary } from './firewall.ts'
import { lanBindState, removeManagedBlock } from './lan-bind.ts'
import { FORWARD_UPSTREAM_HOST, LanForwarder, type LanForwardState } from './lan-forward.ts'
import { firewallActionNeeded, forwardPlanOf, isLanReachableBind, resolveManagedProfile, type AppliedFirewallState, type ForwardStopReason, type LanBindCapability, type StartupFacts } from './lan-bind-plan.ts'
import { bindUrlHostOf, isWildcardLiteral, wildcardBindSupported, type ConfigSchemaFactory } from './host-bind-capability.ts'
import { createInnerAuth } from './inner-auth.ts'
import { withIdentityEncoding } from './http.ts'
import { mountOnce } from './mount-once.ts'
import { runDetached } from './detached-work.ts'
import { REMOTE_CHANNEL_BOOT_SCRIPT } from './remote-channel-boot.ts'
import { UUID_POLYFILL_SCRIPT } from './uuid-polyfill.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running fiber without a
     * remount; dispatched to the owning fiber only. Spelled here because the
     * Loader package is not a dependency of this plugin, with the Loader's own
     * shape so the two declarations merge when a Host program carries both.
     * @param paths - changed config paths as key arrays; every value is committed before dispatch.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
    /**
     * Waterfall seam on the /api transport fence: the connection plugin
     * fires this per /api request before bridging to the API proxy on
     * deployments that carry the pairing/revocation seam; call `next()` to
     * delegate, return false (without calling it) to veto with 403.
     *
     * Cohort note (0.1.2-alpha.2): the official runtime ships NO emitter
     * for this event, so the listener below never fires there and direct
     * /api stays under the harness fence + browser auth. It is wired anyway
     * so cohort lines that do carry the seam get pairing enforcement on
     * direct /api without a plugin change.
     */
    'api/gate'(
      this: Context,
      request: IncomingMessage,
      method: string | undefined,
      next: () => boolean | Promise<boolean>,
    ): boolean | Promise<boolean>
  }
}

/** Stable cordis plugin name. */
export const name = 'deh-remote'

/** Services required before the pairing surfaces can mount. */
export const inject = ['webServer', 'typertGateway', 'connection']

/**
 * Settings namespace of the remote-control capability. Under the 0.1.7
 * settings model the namespace IS the Host profile entry id, so this is also
 * the id the browser half asks `ctx.configForms` for (the family binder
 * resolves the same value to the owning entry). Spelled here rather than
 * imported: the browser half spells the same value and must not depend on a
 * Host package.
 */
export const REMOTE_WEB_UI_SETTINGS_NAMESPACE = 'deh-remote' as SettingsNamespace

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Token lifetime in ms; the QR link dies after this. */
  tokenTtlMs?: number
  /** A device is "online" while its lastSeenAt is newer than this (ms). */
  offlineAfterMs?: number
  /** Hard cap on paired device sessions (oldest evicted when full). */
  maxDevices?: number
  /**
   * Idle sessions older than this (ms) are deleted from memory and disk.
   * Default is 30 days; a leftover cookie no longer authorizes after expiry.
   */
  idleExpireMs?: number
  /** Cookie name carrying the paired device id. */
  cookieName?: string
  /**
   * When true (default), a desktop Web GUI opened at a non-loopback origin
   * rides the gated `/remote/api` channel, whose requests must carry a live
   * paired-device cookie — the QR is the only way into remote desktop, and
   * stop()/revoke() cut the channel and the pairing cookie off immediately.
   * This policy selects the transport; it never loosens the channel, whose
   * gate is unconditional (issue #1665). Scope
   * note for this cohort: direct /api is governed by the harness fence +
   * browser-auth cookie (the api/gate seam has no emitter on 0.1.2-alpha.2),
   * so a harness browser credential a device has already redeemed is not
   * invalidated by stop() — see the README security model. Set false to keep
   * the desktop on plain `/api` (only useful when that origin is already
   * trusted for `/api`). Turning the policy off does NOT open the channel:
   * the /remote proxy attaches the process's own browser-auth credential only
   * when the request itself presents a live paired-device credential, so an
   * unpaired LAN/tunnel caller is forwarded without it and the inner route
   * answers 401.
   */
  requirePairingForLan?: boolean
  /**
   * Absolute path to a JSON file where paired device sessions are persisted.
   * Defaults to `$DSH_HOME/remote-web-ui-devices.json` so a paired device
   * keeps its session across `dsh web` restarts (the cookie already lives
   * 365 days). Override to another absolute path when needed.
   */
  devicesFile?: string
  /**
   * LAN access toggle: the one switch that decides whether this machine's
   * local-area network can reach the desktop Web GUI.
   *
   * The plugin never rewrites the host web server's binding (issue #1917).
   * Turning the toggle on starts the runtime LAN forwarder
   * (`src/lan-forward.ts`): it listens on this machine's LAN IPv4 address at
   * the web server's own port and forwards to `127.0.0.1:<same port>`, so the
   * host keeps its loopback listener and `--host`/`--port` keep their
   * ordinary meaning. The matching host firewall rule is maintained alongside
   * (Windows netsh; Linux firewalld/ufw/iptables; other platforms report the
   * firewall as unmanaged). A failed bind or a refused firewall rule costs the
   * LAN entry only — the loopback listener is never touched.
   */
  lanBind?: boolean
  /**
   * The profile whose cordis.patch.yml the LAN bind toggle manages. Defaults
   * to the profile the Host booted (its `profileContext`), then to the
   * DSH_PROFILE environment variable, then "web" — the Desktop client boots
   * "desktop" without exporting DSH_PROFILE, so the environment alone names
   * the wrong profile there. Must be a single safe path segment (the runtime
   * and environment fallbacks bypass this schema, so the path builder asserts
   * containment independently).
   */
  profile?: string
  /**
   * Master switch for the plugin (browser half + host pairing surfaces).
   * Defaults to OFF: remote control is an opt-in capability, so a fresh
   * install exposes neither the sidebar entry, the pairing routes, nor the
   * LAN forwarder until the operator turns it on in this plugin's settings
   * card. Turning it on is the only switch a new install needs; keeping it
   * off leaves the host exactly as it was before the plugin was installed.
   */
  enabled?: boolean
}

/**
 * Plugin config schema. Under the 0.1.7 settings model this schema IS the
 * entry's settings page: the Host derives one form per profile entry from it
 * and serves that form only when at least one field is `volatile()`. The marker
 * is also what admits a write and what keeps the edit on the live path — the
 * Loader commits the new value into the field's reference and announces
 * `loader/volatile-update` on this fiber instead of remounting the row, so the
 * pairing service, its device sessions, and the route registrations survive a
 * settings save (see {@link applyImpl}'s sync).
 *
 * The schema is left to inference rather than annotated with `z<Config>`: a
 * volatile field's parsed output is a live reference while its accepted input
 * stays the plain value, so the two sides no longer share one shape and the
 * annotation would reject the schema the Host must be given.
 *
 * The deployment-level fields (`devicesFile`, `profile`) are deliberately NOT
 * volatile: they belong in the profile patch, so the form leaves them to the
 * operator instead of offering a card control that a document write could not
 * honor.
 */
export const Config = z.object({
  tokenTtlMs: z.number().step(1).min(60_000).default(10 * 60_000).volatile(),
  offlineAfterMs: z.number().step(1).min(5_000).default(25_000).volatile(),
  maxDevices: z.number().step(1).min(1).max(64).default(4).volatile(),
  idleExpireMs: z.number().step(1).min(60_000).default(DEFAULT_IDLE_EXPIRE_MS).volatile(),
  cookieName: z.string().min(1).default('dsh_pair').volatile(),
  requirePairingForLan: z.boolean().default(true).volatile(),
  devicesFile: z.string(),
  lanBind: z.boolean().default(false).volatile(),
  profile: z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  enabled: z.boolean().default(false).volatile(),
})

/** Presence sweep cadence (a stale device flips to disconnected within two sweeps). */
const SWEEP_INTERVAL_MS = 10_000

/**
 * Fully resolved config: every field non-optional except `devicesFile`,
 * `lanBind` and `profile`, whose schema keeps them optional (so `Required`
 * alone would over-narrow them).
 */
type ResolvedConfig = Required<Omit<Config, 'devicesFile' | 'lanBind' | 'profile'>> & {
  devicesFile: string
  /** The LAN access toggle; the schema default keeps it a plain boolean. */
  lanBind: boolean
  profile: string
}

/**
 * The stable reference a `volatile()` config field resolves to; its owner
 * updates it in place when the user saves.
 */
interface ConfigRef<T> {
  /** @returns the value currently committed for the running instance. */
  get(): T
}

/** One resolved config field: a live reference, or a plain value from a hand-built context. */
type ConfigField<T> = ConfigRef<T> | T

/** The config the Host hands {@link applyImpl} — the runtime face of {@link Config}. */
export interface ResolvedConfigFields {
  tokenTtlMs?: ConfigField<number>
  offlineAfterMs?: ConfigField<number>
  maxDevices?: ConfigField<number>
  idleExpireMs?: ConfigField<number>
  cookieName?: ConfigField<string>
  requirePairingForLan?: ConfigField<boolean>
  devicesFile?: ConfigField<string>
  lanBind?: ConfigField<boolean>
  profile?: ConfigField<string>
  enabled?: ConfigField<boolean>
}

/** Read one resolved config field, following the live reference the schema produces. */
function readConfigField<T>(field: ConfigField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as ConfigRef<T>).get === 'function') {
    const value = (field as ConfigRef<T>).get()
    return value === undefined ? fallback : value
  }
  return field as T
}

/**
 * Read one optional resolved config field. A volatile reference is read at
 * call time, so an unset field stays `undefined` rather than falling back to a
 * schema default (the distinction the LAN access toggle depends on).
 */
function readOptionalConfigField<T>(field: ConfigField<T> | undefined): T | undefined {
  if (field === undefined) return undefined
  if (typeof field === 'object' && field !== null && typeof (field as ConfigRef<T>).get === 'function') {
    return (field as ConfigRef<T>).get()
  }
  return field as T
}

/**
 * The single mapping from resolved plugin config to the pairing service
 * config. Both the constructed service and every later apply of this row
 * reuse it, so no field can be silently dropped.
 */
export function pairingConfigOf(resolved: Pick<
  ResolvedConfig,
  'tokenTtlMs' | 'offlineAfterMs' | 'maxDevices' | 'idleExpireMs' | 'cookieName' | 'devicesFile'
>): PairingConfig {
  return {
    tokenTtlMs: resolved.tokenTtlMs,
    offlineAfterMs: resolved.offlineAfterMs,
    maxDevices: resolved.maxDevices,
    idleExpireMs: resolved.idleExpireMs,
    cookieName: resolved.cookieName,
    devicesFile: resolved.devicesFile,
  }
}

/** Default paired-session store: `$DSH_HOME/remote-web-ui-devices.json`. */
export function defaultDevicesFile(home: string = dshHome()): string {
  return join(home, 'remote-web-ui-devices.json')
}

/** Schema defaults, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULTS: ResolvedConfig = {
  tokenTtlMs: 10 * 60_000,
  offlineAfterMs: 25_000,
  maxDevices: 4,
  idleExpireMs: DEFAULT_IDLE_EXPIRE_MS,
  cookieName: 'dsh_pair',
  requirePairingForLan: true,
  devicesFile: defaultDevicesFile(),
  lanBind: false,
  profile: resolveManagedProfile(undefined, undefined, process.env.DSH_PROFILE),
  enabled: false,
}

/**
 * The launched profile the Host publishes on its `profileContext` service
 * (`{ name, dir, patchPath, … }`). The Desktop client boots the "desktop"
 * profile without exporting DSH_PROFILE, so the environment alone resolves
 * the wrong profile there and the LAN bind toggle would edit a profile that
 * is not running.
 * @param ctx - host plugin context.
 * @returns the profile name when the Host publishes one; undefined otherwise.
 */
function launchedProfileName(ctx: Context): string | undefined {
  const fact = ctx.get('profileContext') as { name?: unknown } | undefined
  return typeof fact?.name === 'string' && fact.name.length > 0 ? fact.name : undefined
}

/**
 * Mount the pairing service, routes, gate listener, and presence sweep.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('@echo-125/deh-remote', applyImpl)

/**
 * What the running host accepts as a bind, sampled once per boot: the installed
 * webserver schema decides the wildcard (see host-bind-capability.ts) and the
 * interface list is frozen for the same reason the QR bases are.
 *
 * The plugin no longer writes a bind anywhere (issue #1917), so the schema
 * answer is reported to the settings card and never turned into a profile row;
 * the LAN edge listens on a concrete interface literal, which every schema
 * line accepts.
 * @param configOf - schema factory override (test seam); the installed package's own by default.
 * @returns the capability the LAN-edge plan is computed against.
 */
export function lanBindCapabilityOf(
  configOf?: ConfigSchemaFactory,
): LanBindCapability {
  return {
    wildcardSupported: wildcardBindSupported(configOf),
    candidates: lanIPv4Addresses(),
  }
}

/**
 * The LAN URL bases a non-loopback bind is reachable by. A wildcard bind
 * answers every interface, so each candidate gets its own base (a multi-homed
 * machine can pick the network the phone actually reaches). A concrete literal
 * is only reachable at that literal, so it is the only base advertised.
 * @param host - the live bind, or the block host on a process whose bind is not settled.
 * @param port - the bound port.
 * @returns the bases, empty when the bind stays on this machine.
 */
export function lanBasesOf(host: string | undefined, port: number): { address: string; base: string }[] {
  if (typeof host !== 'string' || !isLanReachableBind(host)) return []
  const addresses = isWildcardLiteral(host)
    ? lanIPv4Addresses()
    // A literal with no URL form (a non-loopback IPv6 zone id) is unadvertisable:
    // an invented base would cost a phone the whole pairing attempt.
    : [bindUrlHostOf(host)].filter((address): address is string => address !== undefined && address !== '')
  return addresses.map(address => ({ address, base: `http://${address}:${String(port)}` }))
}

/** The facts the LAN-bind status frame is built from, read at request time. */
export interface LanBindFrameInput {
  /** The managed profile. */
  profile: string
  /** The toggle: true/false once flipped, undefined while untouched. */
  setting: boolean | undefined
  /** The host a previous version's managed block still pins, before cleanup. */
  blockHost: string | undefined
  /** The live bind of the running web server (loopback in this design). */
  bindHost: string | undefined
  /** The LAN forwarder's live state. */
  forward: LanForwardState
  /** Why the forwarder is off, when the toggle asks for it. */
  forwardReason: ForwardStopReason | undefined
  /** Whether this process removed the block a previous version left behind. */
  legacyBlockRemoved: boolean
  /** The bound port, when it has settled. */
  port: number | undefined
  /** What the installed webserver schema accepts (reported, never written). */
  wildcardSupported: boolean
  /** The local non-loopback IPv4 literals this process could listen on. */
  candidates: string[]
  /** The CLI startup facts the plan is computed against. */
  startupHost: string | undefined
}

/**
 * The LAN-bind status frame the loopback-only `/api/pair/lan-bind` endpoint
 * serves, built as one pure value so every field has direct unit coverage.
 *
 * `bindHost` is the address LAN clients can actually dial - the forwarder's
 * listener, or the running bind when the operator pointed `--host` at the
 * network - because that is what the card renders as "bind: host:port".
 * `localBindHost` keeps the host process's own listener visible beside it.
 * @param input - the facts read at request time.
 * @param firewallOf - firewall summary reader (injected in tests).
 * @returns the frame the settings card reads.
 */
export function lanBindFrameOf(
  input: LanBindFrameInput,
  firewallOf: (port: number, lanOn: boolean) => FirewallSummary = firewallSummary,
): Record<string, unknown> {
  const capability: LanBindCapability = {
    wildcardSupported: input.wildcardSupported,
    candidates: input.candidates,
  }
  const plan = forwardPlanOf(input.setting, input.startupHost, capability)
  // Reachability is the LAN edge, never the host's own bind: the forwarder's
  // listener when it is up, and the running bind when the operator made the
  // host itself listen on the network (the forwarder yields that port).
  const reachHost = input.forward.listening ? input.forward.address : input.bindHost
  return {
    profile: input.profile,
    setting: input.setting ?? null,
    blockHost: input.blockHost ?? null,
    bindHost: reachHost,
    localBindHost: input.bindHost ?? null,
    port: input.port,
    lanUrls: input.port !== undefined
      ? lanBasesOf(reachHost, input.port).map(entry => entry.base)
      : [],
    firewall: input.port !== undefined
      ? firewallOf(input.port, isLanReachableBind(reachHost))
      : { ok: true, managed: false },
    platform: process.platform,
    /** The LAN address the forwarder plans to listen on; null when it must stay off. */
    desiredHost: plan.host ?? null,
    /** Whether the running host's schema accepts the wildcard bind (reported only). */
    wildcardSupported: input.wildcardSupported,
    /** The concrete LAN literals this process could listen on. */
    supportedHosts: input.candidates,
    /** The toggle is on but this machine has no LAN IPv4 address to listen on. */
    lanBlocked: plan.reason === 'no-address',
    // Always false: nothing this plugin does needs a restart any more. The
    // field stays in the frame because the card renders it (the copy for the
    // new failure states lands with the client/i18n follow-up).
    pendingRestart: false,
    /** The block a previous version wrote was removed by this process. */
    legacyBlockRemoved: input.legacyBlockRemoved,
    /** The LAN edge itself: what it listens on, and why not when it is off. */
    forward: {
      listening: input.forward.listening,
      host: input.forward.address ?? null,
      port: input.forward.port ?? null,
      // A listening edge has no "why off": the reason only describes a stopped one.
      reason: input.forward.listening ? null : (input.forwardReason ?? null),
      error: input.forward.error ?? null,
    },
  }
}

function applyImpl(ctx: Context, config?: ResolvedConfigFields): void {
  // The settings are read through the volatile references at every call rather
  // than captured once: a settings save commits into those references and
  // announces `loader/volatile-update` (see the listener below), so resolving
  // them here is what makes a live edit reach the running instance without a
  // remount — and keeps the device sessions and the routes alive.
  const resolve = (): ResolvedConfig => ({
    tokenTtlMs: readConfigField(config?.tokenTtlMs, DEFAULTS.tokenTtlMs),
    offlineAfterMs: readConfigField(config?.offlineAfterMs, DEFAULTS.offlineAfterMs),
    maxDevices: readConfigField(config?.maxDevices, DEFAULTS.maxDevices),
    idleExpireMs: readConfigField(config?.idleExpireMs, DEFAULTS.idleExpireMs),
    cookieName: readConfigField(config?.cookieName, DEFAULTS.cookieName),
    requirePairingForLan: readConfigField(config?.requirePairingForLan, DEFAULTS.requirePairingForLan),
    devicesFile: readConfigField(config?.devicesFile, DEFAULTS.devicesFile),
    lanBind: readConfigField(config?.lanBind, DEFAULTS.lanBind),
    profile: resolveManagedProfile(readOptionalConfigField(config?.profile), launchedProfileName(ctx), process.env.DSH_PROFILE),
    enabled: readConfigField(config?.enabled, DEFAULTS.enabled),
  })
  const service = new PairingService(pairingConfigOf(resolve()))

  // The bind facts are known by now (webServer is an inject edge): the LAN
  // bases are frozen per process, matching the CLI's once-per-invocation
  // sampling stance. The QR can only advertise addresses the fence accepts;
  // every interface gets its own base URL so a multi-homed machine can pick
  // the network the phone can actually reach.
  // A recompose pass can hand the plugin a webServer whose facts have not
  // settled yet (host unset, port undefined); deriving LAN bases from that
  // would advertise :undefined links or clear a working set, so the bases
  // only update when both facts are readable.
  // The reachability signal is "the bind is not loopback", never equality with
  // the wildcard: a host that refuses wildcard binds serves the LAN from one
  // concrete interface address, which an equality check would read as
  // local-only (issue #1893).
  const bindKnown = typeof ctx.webServer.host === 'string' && ctx.webServer.host !== ''
    && Number.isFinite(ctx.webServer.port)
  if (bindKnown) {
    service.setLanBases(lanBasesOf(ctx.webServer.host, ctx.webServer.port as number))
  }

  // Push the effective configuration into the service and gate. The service
  // config object is read per operation (token mint, touch, sweep), and the
  // gate re-reads its fence flag per request, so a saved edit takes effect
  // without a restart (the Host reloads this row, and apply re-runs). When
  // `enabled` is off, the pairing routes and sweep timer are dropped and all
  // device/token state is revoked, but the gate listener stays mounted so a
  // LAN-exposed /api stays behind pairing (now vetoing every non-loopback
  // request) instead of opening the fence.
  let disposeRoutes: (() => void) | undefined
  let disposeSweep: (() => void) | undefined
  // LAN-bind facts for the settings card, re-read per request so a hot
  // rebind (the patch watcher recomposes the process) and a fresh toggle
  // round are both reflected without a restart.
  let lastKnownPort: number | undefined
  let lastFirewallApplied: AppliedFirewallState | undefined
  // What the running host accepts, sampled once per boot: the schema cannot
  // change under a running process, and the candidate list is frozen for the
  // same reason the QR bases are. One value therefore drives both the block the
  // re-assert writes and the capability the status frame reports, so the card
  // never explains a literal the write path would not have chosen.
  const capability = lanBindCapabilityOf()
  const lanBindStatus = (): Record<string, unknown> => {
    const resolvedNow = resolve()
    let state: { blockPresent: boolean; host?: string; port?: number }
    try {
      state = lanBindState(resolvedNow.profile)
    } catch {
      // An unsafe profile value must not take the whole status endpoint down.
      state = { blockPresent: false }
    }
    const port = Number.isFinite(ctx.webServer.port) ? ctx.webServer.port : lastKnownPort
    if (Number.isFinite(ctx.webServer.port)) lastKnownPort = ctx.webServer.port
    return lanBindFrameOf({
      profile: resolvedNow.profile,
      // The effective LAN edge is the toggle AND the master switch, so the card
      // reports what is actually true, not what the toggle alone asks for.
      setting: resolvedNow.enabled ? resolvedNow.lanBind : false,
      blockHost: state.host,
      bindHost: ctx.webServer.host,
      forward: forwarder.snapshot(),
      forwardReason,
      legacyBlockRemoved,
      port,
      wildcardSupported: capability.wildcardSupported,
      candidates: capability.candidates,
      startupHost: (ctx.get('webStartup') as StartupFacts | undefined)?.host,
    })
  }
  // The process's inner browser credential: the proxied /api re-issues to
  // 127.0.0.1, where the connection route enforces the harness browser-auth
  // cookie (authority-bound; no loopback exemption on this cohort), so a
  // device's own cookie can never satisfy the inner check. The plugin
  // redeems its own launch token once and attaches the cookie to inner
  // requests; the credential is only ever exercised behind the pairing gate
  // in remote-api.ts.
  const innerAuth = createInnerAuth(() => {
    if (!Number.isFinite(ctx.webServer.port)) return undefined
    try {
      return (ctx.connection as { authenticatedUrl?: (base: string) => string }).authenticatedUrl?.(`http://127.0.0.1:${String(ctx.webServer.port)}/`)
    } catch {
      return undefined
    }
  })
  // The official index document for the /pair-app landing, fetched from the
  // inner loopback with the process credential and cached briefly (the shell
  // is static; skins/injections settle right after boot).
  const APP_SHELL_TTL_MS = 30_000
  let appShellCache: { at: number; html: string } | undefined
  const fetchAppShell = async (): Promise<string | undefined> => {
    if (!Number.isFinite(ctx.webServer.port)) return undefined
    if (appShellCache !== undefined && Date.now() - appShellCache.at < APP_SHELL_TTL_MS) return appShellCache.html
    const cookie = await innerAuth.ready()
    try {
      const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/`, withIdentityEncoding({
        headers: cookie !== undefined ? { cookie } : undefined,
      }))
      if (!response.ok) {
        // A stale credential (secret rotation, 30-day TTL) must not wedge every
        // later landing: drop it so the next attempt re-redeems, exactly as the
        // proxy path does on an upstream 401.
        if (response.status === 401 || response.status === 403) innerAuth.invalidate()
        return undefined
      }
      const html = await response.text()
      appShellCache = { at: Date.now(), html }
      return html
    } catch {
      return undefined
    }
  }
  const routes = [
    ...makeRoutes({
      service,
      requirePairingForLan: () => resolve().requirePairingForLan,
      lanBindStatus,
      indexDocument: fetchAppShell,
    }),
    // The remote desktop channel: a paired-credential-gated `/remote` prefix
    // that re-issues fenced paths to loopback (see remote-api.ts). The gate is
    // unconditional — requirePairingForLan governs the plain /api surface and
    // the desktop's client-side rewrite only; it is never an authorization
    // input here, because this channel attaches the process's own browser
    // credential to everything it forwards (issue #1665).
    ...makeRemoteApiRoutes({
      service,
      port: () => ctx.webServer.port,
      auth: innerAuth,
    }),
  ]
  const upgrades = makeRemoteApiUpgradeRoutes({
    service,
    port: () => ctx.webServer.port,
    auth: innerAuth,
  })
  const gate = makeGateListener(service, () => resolve().requirePairingForLan, () => resolve().enabled)
  ctx.effect(() => ctx.on('api/gate', gate), 'remote-web-ui: api gate')
  // Sibling plugins (dsh-better-sidebar, etc.) look this up by name. Absent
  // when this plugin is not installed; stop() / enabled=false still refuse
  // cookies.
  new RemoteWebUiPairing(ctx, (request) => {
    if (!resolve().enabled) return false
    return isPairedDeviceRequest(service, request)
  })

  // ── the LAN edge (issue #1917) ──────────────────────────────────────────
  // This plugin owns no bind. The web server's row is the profile's own, and it
  // was never this plugin's to rewrite: a same-id patch row replaces the whole
  // config (so --host/--port were swallowed), and the profile patch is exactly
  // what the Host's HMR config watcher refreshes from (so writing it rebound the
  // live listener mid-session). LAN reachability comes from the runtime
  // forwarder instead (lan-forward.ts): the host keeps listening on loopback and
  // the forwarder serves the LAN address on the same port.
  const forwarder = new LanForwarder()
  /** Why the forwarder is off as of the last reconcile; the status frame reports it. */
  let forwardReason: ForwardStopReason | undefined = 'off'
  /** Whether this process removed the block a previous version left behind. */
  let legacyBlockRemoved = false
  /** The legacy cleanup runs once per process, ahead of every other bind step. */
  let legacyCleanupDone = false

  /** The address a LAN client dials right now: the forwarder, else the host's own bind. */
  const lanEdgeHost = (): string | undefined => {
    const state = forwarder.snapshot()
    return state.listening ? state.address : ctx.webServer.host
  }

  /**
   * Point the pairing service at the authority phones actually dial. The QR
   * bases and the phone-facing fences compare the Host header against this
   * list, so following the forwarder is what keeps a paired phone paired.
   */
  const applyLanBases = (): void => {
    if (!Number.isFinite(ctx.webServer.port)) return
    service.setLanBases(lanBasesOf(lanEdgeHost(), ctx.webServer.port as number))
  }

  /**
   * Remove the managed block a previous version (<= 0.4.8) wrote, once per
   * process and before anything else touches the profile. A surviving block
   * keeps replacing the web server row's config wholesale, so every later start
   * ignores --host/--port and binds a literal an older plugin guessed - the
   * exact failure this issue is about. Nothing is written back.
   * @param profile - the managed profile whose patch file may carry the block.
   */
  const cleanupLegacyBlock = (profile: string): void => {
    if (legacyCleanupDone) return
    legacyCleanupDone = true
    try {
      const result = removeManagedBlock(profile)
      legacyBlockRemoved = result.removed
    } catch (error) {
      // A block that cannot be removed keeps swallowing the bind on every later
      // start, so this failure is reported loudly instead of skipped. The LAN
      // edge still runs: it does not depend on the profile file at all.
    }
  }

  /**
   * Bring the LAN edge in line with the toggle. Every failure here costs the LAN
   * edge only: the loopback listener is never touched, so an address that
   * disappeared after a network change or a port already taken cannot brick the
   * host - the reason is logged and reported on the status frame.
   * @param value - the effective plugin configuration.
   */
  const applyForwardEdge = (value: ResolvedConfig): void => {
    const startup = ctx.get('webStartup') as StartupFacts | undefined
    // `enabled` is the master switch and defaults to OFF, so a disabled plugin
    // must not leave a LAN listener open behind it: the forwarder is planned
    // against the toggle AND the switch, and an off switch stops a running one.
    const wanted = value.enabled && value.lanBind
    // The interface list is re-sampled per reconcile (unlike the schema answer,
    // which cannot change under a running process): a machine that changed
    // networks must not keep serving a LAN address it no longer has, and the
    // plan follows the address it does have.
    const liveCapability: LanBindCapability = { wildcardSupported: capability.wildcardSupported, candidates: lanIPv4Addresses() }
    const plan = forwardPlanOf(wanted, startup?.host, liveCapability)
    forwardReason = plan.reason
    const state = forwarder.snapshot()
    const port = Number.isFinite(ctx.webServer.port) ? ctx.webServer.port as number : undefined
    if (plan.host === undefined || port === undefined) {
      if (state.listening) void forwarder.stop().then(applyLanBases)
      else applyLanBases()
      return
    }
    if (state.listening && state.address === plan.host && state.port === port) return
    const host = plan.host
    // A bind that cannot be taken costs the LAN edge only; the status frame
    // reports why (forward.error), and nothing is printed to the host console.
    void forwarder.start(host, port).then(() => { applyLanBases() })
  }

  /**
   * The bind work one sync runs: the legacy block removal, the LAN edge, and the
   * firewall rule. It never writes a profile file except to remove the block an
   * older version left there.
   *
   * The scheduling that reaches it still runs through runDetached (see
   * scheduleLanBindWork): a settings save holds the Host's exclusive HMR
   * transaction in its async context, and a config-file write from inside that
   * context makes the watcher's refresh re-enter it ("HMR transactions cannot be
   * nested", #1751/#1754). The removal is a no-op on every boot after the first,
   * so the ordinary path writes nothing at all.
   * @param value - the effective plugin configuration.
   */
  const applyLanBindWork = (value: ResolvedConfig): void => {
    cleanupLegacyBlock(value.profile)
    applyForwardEdge(value)
    if (value.lanBind === undefined) return
    // Keep the firewall rule aligned with the toggle (managed platforms only;
    // see firewall.ts). The probes and rule rewrites are blocking subprocesses,
    // so they run only when the desired state actually moved - not on every
    // unrelated settings save. The port is the live bind port; without it there
    // is nothing to align yet.
    const livePort = Number.isFinite(ctx.webServer.port) ? ctx.webServer.port : undefined
    if (livePort === undefined) {
      return
    }
    const nextFirewall: AppliedFirewallState = { enabled: value.enabled && value.lanBind === true, port: livePort }
    if (!firewallActionNeeded(lastFirewallApplied, nextFirewall)) return
    const ruleOk = nextFirewall.enabled ? ensureFirewallRule(nextFirewall.port) : removeFirewallRule(nextFirewall.port)
    if (ruleOk) {
      lastFirewallApplied = nextFirewall
    }
  }

  // The forwarder and its connections belong to this activation: a dispose (or a
  // remount) must leave no orphan listener behind.
  ctx.effect(() => () => { void forwarder.stop() }, 'remote-web-ui: lan forwarder')

  // The LAN bind assertion never blocks the caller: one pending work item is
  // enough, and it always re-reads the config through `resolve()` at run time
  // so a toggle flipped twice before the tick lands on the last value.
  //
  // The scheduling itself runs through runDetached: the settings save that
  // drives sync() holds the Host's exclusive HMR transaction in its async
  // context, and a `setImmediate` scheduled directly from here would inherit
  // that mark (measured on Node 24), so the write would still land inside the
  // transaction the watcher then tries to re-enter. Scheduling from the
  // module-scope resource starts the timer - and therefore the write - with no
  // store at all.
  let lanBindWorkPending = false
  const scheduleLanBindWork = (): void => {
    if (lanBindWorkPending) return
    lanBindWorkPending = true
    runDetached(() => setImmediate(() => {
      lanBindWorkPending = false
      try {
        applyLanBindWork(resolve())
      } catch (error) {
        // A deferred assertion must never surface as an unhandled rejection:
        // the settings save that triggered it already answered, and the card
        // reads the live block state back on its own poll.
      }
    }))
  }
  ctx.effect(() => () => { lanBindWorkPending = false }, 'remote-web-ui: lan-bind work')

  // Apply the effective configuration to the running surfaces once per
  // activation: the service tunables, the LAN edge and firewall, the pairing
  // routes, and the presence sweep.
  const sync = (): void => {
    const value = resolve()
    service.config = pairingConfigOf(value)
    scheduleLanBindWork()
    const enabled = value.enabled
    if (!enabled) {
      service.stop()
    }
    if (disposeRoutes === undefined && enabled) {
      disposeRoutes = ctx.effect(
        () => {
          const disposers = [
            ...routes.map(route => ctx.webServer.register(route)),
            ...upgrades.map(route => ctx.webServer.registerUpgrade(route)),
          ]
          return () => { for (const dispose of disposers) dispose() }
        },
        'remote-web-ui: pairing routes',
      )
    } else if (disposeRoutes !== undefined && !enabled) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeSweep === undefined && enabled) {
      disposeSweep = ctx.effect(
        () => {
          const timer = nodeSetInterval(() => { service.sweep() }, SWEEP_INTERVAL_MS)
          timer.unref()
          return () => { clearInterval(timer) }
        },
        'remote-web-ui: presence sweep',
      )
    } else if (disposeSweep !== undefined && !enabled) {
      disposeSweep()
      disposeSweep = undefined
    }
  }
  // Inject the crypto.randomUUID polyfill before any other script runs, so that
  // the main bundle doesn't crash on non-secure contexts (LAN HTTP)
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: UUID_POLYFILL_SCRIPT })
  }), 'remote-web-ui: uuid polyfill')

  // Issue #987: the browser-half channel patch installs at this plugin's
  // boot entry, but dsh-client-connection boots earlier and opens its event
  // streams unrewritten — on a non-loopback origin the SDK fence rejects
  // them and the workspace list never loads. Contribute the rewrite as a
  // parse-time head script so it is active before ANY boot entry runs; the
  // client apply adopts the installed seat instead of patching twice. The
  // row follows the live steady-state decision (enabled + pairing gate); the
  // script itself skips loopback origins.
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    const value = resolve()
    if (!value.enabled || !value.requirePairingForLan) return
    table.push({ kind: 'script', placement: 'head', text: REMOTE_CHANNEL_BOOT_SCRIPT })
  }), 'remote-web-ui: remote channel boot patch')

  // The settings write path. The Host commits the new values into this row's
  // volatile references and announces it here instead of remounting the row, so
  // `sync` is what re-applies them: it re-reads every field through those
  // references (see `resolve`) and is idempotent, so a save that changes
  // nothing observable is a no-op while a disable or a LAN access flip lands on
  // the live instance without dropping the pairing service, its device
  // sessions or the route registrations.
  ctx.on('loader/volatile-update', () => { sync() })

  // No settings registration: the Host derives this plugin's settings page
  // from the exported `Config` schema, whose volatile fields are what make the
  // page writable and what route a save through the live path above.
  sync()
}
