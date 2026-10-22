/**
 * Remote-channel diagnostics probe (opt-in, silent).
 *
 * The package never writes to the host console, so this probe reports through
 * two channels only: a structured global (`window.__DSH_REMOTE_DIAG__`) that
 * a technician can read from DevTools or serialise, and the on-page
 * {@link DiagPanel} overlay. Both are inert unless the probe is armed, and
 * arming requires an explicit opt-in (query flag, sessionStorage key, or the
 * host-granted landing), so a normal paired phone never mounts it.
 *
 * What it answers: the phone UI can render fully (REST through the /remote
 * gateway works and the device stays online) while the connection state
 * machine sits in `connecting` forever. Those are two different legs: REST
 * and the event-stream mux. This probe instruments the mux leg alone -
 * handshake outcome, how long the stream survives, frame counts and the
 * reason it ended - which is the only way to tell "never rewrote" from
 * "rewrote but refused" from "accepted then torn down".
 *
 * @module @echo-125/deh-remote/diag-probe
 */

import {
  REMOTE_CHANNEL_RULES,
  REMOTE_CHANNEL_BOOT_GLOBAL,
  REMOTE_HOST_GRANT_GLOBAL,
} from '../remote-channel-rules.ts'
import { isLoopbackHostname, pageOriginFacts } from './remote-channel.ts'

/** One observed WebSocket leg of the remote channel. */
export interface MuxLegSample {
  /** The URL as the browser actually requested it. */
  url: string
  /** True when the URL carries the /remote gateway prefix (boot rewrite fired). */
  rewritten: boolean
  /** True when the URL carries the cookieless device credential. */
  hasDeviceQuery: boolean
  /** Handshake outcome: 'open' | 'error' | 'close-before-open' | 'timeout'. */
  outcome: string
  /** Milliseconds from construction to the outcome. */
  openMs: number
  /** Milliseconds the socket stayed open before it closed (undefined while open). */
  heldMs?: number
  /** Close code reported by the socket, when the server supplied one. */
  code?: number
  /** Close reason reported by the socket. */
  reason?: string
  /** Frames observed on the leg after the handshake. */
  frames: number
  /** Wall-clock time the leg was created. */
  at: number
}

/** The aggregate a technician reads. */
export interface RemoteDiagSnapshot {
  /** Whether the probe is armed and collecting. */
  armed: boolean
  /** Page origin facts: is this a LAN/tunnel page at all. */
  origin: { hostname: string; isLoopback: boolean; secure: boolean }
  /** Whether the boot rewrite seat is installed (channel is live). */
  seatInstalled: boolean
  /** Whether the landing granted host mode. */
  hostGranted: boolean
  /** The transport keys the page exposes (which channels exist). */
  transportKeys: string[]
  /** Whether the transport offers a worker-local stream opener. */
  transportHasOpenStream: boolean
  /** Whether the transport offers a socket factory. */
  transportHasCreateWebSocket: boolean
  /** The transport's stream base URL, when it has one. */
  transportStreamBaseUrl?: string
  /** The official connection state the indicator renders. */
  connectionState?: string
  /** The official generation id, when one is published. */
  generationId?: number
  /** The official interaction mode the client installed with. */
  interactions?: string
  /** Whether the page has a location (a Worker does not). */
  hasLocation: boolean
  /** Whether the connection offers a worker-local stream opener. */
  hasRpcOpen: boolean
  /** The official client's own console messages (why a generation stalls). */
  logs: string[]
  /** Whether the cookieless device credential is present. */
  devicePresent: boolean
  /** Every mux leg observed, newest last. */
  legs: MuxLegSample[]
  /** Consecutive legs that opened but ended before the ready window. */
  shortLived: number
  /** REST calls through the /remote prefix, by HTTP status. */
  rest: Record<string, number>
  /** Last REST error body, truncated. */
  lastRestError?: string
}

const MAX_LEGS = 24
const MAX_REST_ERROR = 400

/**
 * Probe options (dependency injection for tests).
 * @property now - clock seam.
 * @property WebSocket - constructor seam.
 * @property fetch - fetch seam.
 */
export interface DiagProbeOptions {
  now?: () => number
  WebSocket?: typeof WebSocket
  fetch?: typeof fetch
  /** Reads the official connection state (the indicator's own source). */
  connectionState?: () => string | undefined
  /** Reads the official generation id. */
  generationId?: () => number | undefined
  /** Reads the official interaction mode. */
  interactions?: () => string | undefined
  /** Whether the connection offers a worker-local stream opener. */
  hasRpcOpen?: () => boolean
}

/**
 * Arm decision: the probe is opt-in and defaults OFF. A paired phone in
 * normal use must never pay for it, and a LAN page is the only place it can
 * say anything useful (on loopback the channel is deliberately inert).
 * @param win - the window to inspect.
 * @returns whether to install the probe.
 */
export function diagArmed(
  win: Pick<Window, 'location'> & Partial<Pick<Window, 'sessionStorage' | 'localStorage'>> = window,
): boolean {
  try {
    const params = new URLSearchParams(win.location.search)
    // A bare flag ("?remoteDiag") parses to an empty string: presence is
    // the signal, and an explicit "0"/"false" still means off.
    if (params.has('remoteDiag')) {
      const flag = params.get('remoteDiag') ?? ''
      if (flag !== '0' && flag !== 'false') return true
    }
    // A missing storage (or a denied one) yields undefined/null, which must
    // read as "not armed" - not as "armed with an unknown value".
    const stored = win.sessionStorage?.getItem('dsh-remote-diag')
      ?? win.localStorage?.getItem('dsh-remote-diag')
    if (typeof stored === 'string' && stored !== '') return true
  } catch {
    // Storage denied (private mode): fall through to off.
  }
  return false
}

/**
 * Pathname of a requested URL, best effort. The gateway prefix must be matched
 * positionally: "remote" also occurs inside the mux path itself
 * (/api/remote.mux), so a substring test would label a raw leg rewritten.
 * @param raw - the requested URL.
 * @param win - the window supplying the base for relative URLs.
 * @returns the pathname, or the raw string when it does not parse.
 */
function pathnameOf(raw: string, win: Pick<Window, 'location'>): string {
  try {
    return new URL(raw, win.location.href).pathname
  } catch {
    return raw
  }
}

/**
 * Whether a requested URL carries a given query parameter.
 * @param raw - the requested URL.
 * @param key - the query parameter name.
 * @param win - the window supplying the base for relative URLs.
 * @returns true when the parameter is present.
 */
function hasQuery(raw: string, key: string, win: Pick<Window, 'location'>): boolean {
  try {
    return new URL(raw, win.location.href).searchParams.has(key)
  } catch {
    return false
  }
}

/**
 * Install the diagnostics probe.
 *
 * The probe must see the FIRST mux leg, not only the ones that follow a failed
 * attempt: the official client opens its mux before any client plugin code
 * runs, so a probe installed in the plugin's apply() misses exactly the leg
 * that decides the outcome. The boot patch is parse-time, so the probe has to
 * be too - it rides the same seat, installed by the host's index injection.
 *
 * @param win - the window to instrument.
 * @param options - clock/transport seams.
 * @returns a disposer restoring both globals, and a snapshot reader.
 */
export function installDiagProbe(
  win: Window & typeof globalThis,
  options: DiagProbeOptions = {},
): { dispose: () => void; snapshot: () => RemoteDiagSnapshot } {
  const now = options.now ?? ((): number => Date.now())
  const OriginalWs = options.WebSocket ?? win.WebSocket
  const OriginalFetch = options.fetch ?? win.fetch

  const legs: MuxLegSample[] = []
  const rest: Record<string, number> = {}
  let lastRestError: string | undefined
  let seatInstalled = false
  let hostGranted = false
  let devicePresent = false
  let transportKeys: string[] = []
  let transportHasOpenStream = false
  let transportHasCreateWebSocket = false
  let transportStreamBaseUrl: string | undefined

  const isMux = (raw: string): boolean => {
    try {
      const url = new URL(raw, win.location.href)
      return url.pathname.endsWith(REMOTE_CHANNEL_RULES.wsPaths[0])
    } catch {
      return false
    }
  }

  class ProbedWebSocket extends OriginalWs {
    constructor(url: string | URL, protocols?: string | string[]) {
      const raw = typeof url === 'string' ? url : url.href
      const started = now()
      const sample: MuxLegSample = {
        url: raw,
        rewritten: pathnameOf(raw, win).startsWith(REMOTE_CHANNEL_RULES.remotePrefix + '/'),
        hasDeviceQuery: hasQuery(raw, REMOTE_CHANNEL_RULES.deviceQuery, win),
        outcome: 'timeout',
        openMs: 0,
        frames: 0,
        at: started,
      }
      super(raw, protocols as string | string[] | undefined)

      if (isMux(raw)) {
        legs.push(sample)
        if (legs.length > MAX_LEGS) legs.shift()
        this.addEventListener('open', () => {
          sample.outcome = 'open'
          sample.openMs = now() - started
        })
        this.addEventListener('message', () => {
          sample.frames += 1
        })
        this.addEventListener('error', () => {
          if (sample.outcome === 'timeout') sample.outcome = 'error'
        })
        this.addEventListener('close', (event) => {
          const closed = now()
          if (sample.outcome === 'timeout') sample.outcome = 'close-before-open'
          sample.heldMs = closed - started
          sample.code = (event as CloseEvent).code
          sample.reason = (event as CloseEvent).reason
        })
      }
    }
  }

  const probedFetch: typeof fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : (input as Request).url
    try {
      const response = await OriginalFetch(input as RequestInfo, init)
      if (pathnameOf(raw, win).startsWith(REMOTE_CHANNEL_RULES.remotePrefix + '/')) {
        const key = String(response.status)
        rest[key] = (rest[key] ?? 0) + 1
        if (!response.ok) {
          try {
            const clone = response.clone()
            lastRestError = (await clone.text()).slice(0, MAX_REST_ERROR)
          } catch {
            // Unreadable body: the status alone is enough.
          }
        }
      }
      return response
    } catch (error) {
      if (pathnameOf(raw, win).startsWith(REMOTE_CHANNEL_RULES.remotePrefix + '/')) {
        rest.networkError = (rest.networkError ?? 0) + 1
        lastRestError = String(error).slice(0, MAX_REST_ERROR)
      }
      throw error
    }
  }

  win.WebSocket = ProbedWebSocket as unknown as typeof WebSocket
  win.fetch = probedFetch

  const parseTimeLegs = (): MuxLegSample[] => {
    // The parse-time probe published by the host (see diag-boot.ts) owns the
    // first leg - the one the apply-time probe is too late to see.
    try {
      const data = (win as unknown as Record<string, { read?: () => { legs?: unknown[] } } | undefined>).__DSH_REMOTE_DIAG_DATA__
      const legs = data?.read?.().legs
      if (!Array.isArray(legs)) return []
      return legs.map((raw) => {
        const leg = raw as {
          url?: string
          at?: number
          outcome?: string
          frames?: number
          openMs?: number
          heldMs?: number
          code?: number
          reason?: string
        }
        const url = String(leg.url ?? '')
        return {
          url,
          rewritten: pathnameOf(url, win).startsWith(REMOTE_CHANNEL_RULES.remotePrefix + '/'),
          hasDeviceQuery: hasQuery(url, REMOTE_CHANNEL_RULES.deviceQuery, win),
          outcome: String(leg.outcome ?? 'unknown'),
          openMs: Number(leg.openMs ?? 0),
          frames: Number(leg.frames ?? 0),
          at: Number(leg.at ?? 0),
          ...(leg.heldMs === undefined ? {} : { heldMs: Number(leg.heldMs) }),
          ...(leg.code === undefined ? {} : { code: Number(leg.code) }),
          ...(leg.reason === undefined ? {} : { reason: String(leg.reason) }),
        }
      })
    } catch {
      return []
    }
  }

  const parseTimeLogs = (): string[] => {
    // The official client's console messages name the reason a generation
    // never becomes ready; the parse-time probe kept them.
    try {
      const data = (win as unknown as Record<string, { read?: () => { logs?: unknown[] } } | undefined>).__DSH_REMOTE_DIAG_DATA__
      const logs = data?.read?.().logs
      if (!Array.isArray(logs)) return []
      return logs.map((entry) => String(entry)).slice(-12)
    } catch {
      return []
    }
  }

  const snapshot = (): RemoteDiagSnapshot => {
    const facts = pageOriginFacts(win as unknown as Parameters<typeof pageOriginFacts>[0])
    try {
      seatInstalled = (win as unknown as Record<string, unknown>)[REMOTE_CHANNEL_BOOT_GLOBAL] !== undefined
    } catch {
      seatInstalled = false
    }
    try {
      hostGranted = (win as unknown as Record<string, unknown>)[REMOTE_HOST_GRANT_GLOBAL] === true
    } catch {
      hostGranted = false
    }
    try {
      // The transport decides whether the forwarded-event stream rides the
      // mux or the RPC channel, so its shape is part of the diagnosis.
      const transport = (win as unknown as Record<string, Record<string, unknown> | undefined>).__DSH_TRANSPORT__
      transportKeys = transport === undefined ? [] : Object.keys(transport)
      transportHasOpenStream = transport !== undefined && typeof transport.openStream === 'function'
      transportHasCreateWebSocket = transport !== undefined && typeof transport.createWebSocket === 'function'
      transportStreamBaseUrl = typeof transport?.streamBaseUrl === 'string' ? transport.streamBaseUrl : undefined
    } catch {
      transportKeys = []
      transportHasOpenStream = false
      transportHasCreateWebSocket = false
      transportStreamBaseUrl = undefined
    }
    try {
      devicePresent = (win.sessionStorage?.getItem(REMOTE_CHANNEL_RULES.deviceKey) ?? null) !== null
    } catch {
      devicePresent = false
    }
    const merged = [...parseTimeLegs(), ...legs]
    const shortLived = merged.filter(
      (leg) => leg.outcome === 'open' && leg.heldMs !== undefined && leg.heldMs < 15_000,
    ).length
    return {
      armed: true,
      origin: {
        hostname: facts.hostname,
        isLoopback: isLoopbackHostname(facts.hostname),
        secure: win.isSecureContext === true,
      },
      seatInstalled,
      hostGranted,
      transportKeys,
      transportHasOpenStream,
      transportHasCreateWebSocket,
      transportStreamBaseUrl,
      connectionState: options.connectionState?.(),
      generationId: options.generationId?.(),
      interactions: options.interactions?.(),
      hasLocation: typeof win.location !== 'undefined',
      hasRpcOpen: options.hasRpcOpen?.() ?? false,
      logs: parseTimeLogs(),
      devicePresent,
      legs: merged,
      shortLived,
      rest: { ...rest },
      lastRestError,
    }
  }

  return {
    dispose: () => {
      win.WebSocket = OriginalWs
      win.fetch = OriginalFetch
    },
    snapshot,
  }
}
