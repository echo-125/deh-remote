/** The /api/pair route family over a real HTTP server: fences, token flow, cookies. */
import { createServer, request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { PairingService } from '../src/pairing.ts'
import { APP_DEVICE_STORAGE_KEY, MAX_DYNAMIC_TRUSTED_HOSTS, acceptLimitKey, addBounded, isTrustedHost, makeRoutes, patchAppShell, PAIR_PATHS } from '../src/routes.ts'
import { LAN_SOURCE_STORAGE_KEY } from '../src/lan-source.ts'
import { createPairGrantStore, type PairGrantStore } from '../src/pair-grant.ts'
import { REMOTE_HOST_GRANT_GLOBAL } from '../src/remote-channel-rules.ts'

function makeService(): PairingService {
  const service = new PairingService({
    tokenTtlMs: 60_000,
    offlineAfterMs: 10_000,
    maxDevices: 4,
    cookieName: 'dsh_pair',
  }, {
    now: () => 1_000_000,
    randomToken: () => 'tok-1',
  })
  service.setLanBases([{ address: '192.168.1.5', base: 'http://192.168.1.5:3080' }])
  return service
}

/** A deterministic one-time grant table (fixed clock, fixed secret). */
function makeGrants(): PairGrantStore {
  return createPairGrantStore({ now: () => 1_000_000, createGrant: () => 'grant-1' })
}

interface TestServer {
  port: number
  close: () => Promise<void>
}

/** Serve the route family from a real server. */
async function serve(routes: WebRoute[]): Promise<TestServer> {
  const server: Server = createServer((request, response) => {
    const route = routes.find(r => {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname
      return r.kind === 'exact' && r.path === pathname
    })
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    void route.handler(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
  }
}

/** One JSON call; host spoofs the authority a browser would send. */
async function call(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  opts: { host?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string; cookies: string[]; referrerPolicy: string | undefined; location: string | undefined; contentType: string | undefined; cacheControl: string | undefined; serviceWorkerAllowed: string | undefined }> {
  return await new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${String(port)}` }
    for (const [name, value] of Object.entries(opts.headers ?? {})) {
      if (name.toLowerCase() !== 'host') headers[name] = value
    }
    if (payload !== undefined) headers['content-type'] = 'application/json'
    if (opts.cookie !== undefined) headers.cookie = opts.cookie
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers },
      (response) => {
        const chunks: Buffer[] = []
        const setCookie = response.headers['set-cookie'] ?? []
        response.on('data', (chunk) => { chunks.push(chunk as Buffer) })
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: Record<string, unknown> = {}
          try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* empty body */ }
          resolve({
            status: response.statusCode ?? 0,
            body,
            raw,
            cookies: setCookie,
            referrerPolicy: response.headers['referrer-policy'],
            location: response.headers['location'],
            contentType: response.headers['content-type'],
            cacheControl: response.headers['cache-control'],
            serviceWorkerAllowed: response.headers['service-worker-allowed'],
          })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** Read the first SSE `data:` frame then abort the stream. */
async function readFirstSse(port: number, path: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } },
      (response) => {
        let buf = ''
        response.on('data', (chunk) => {
          buf += String(chunk)
          const match = /data: (.+)\n\n/.exec(buf)
          if (match?.[1] === undefined) return
          try {
            const parsed = JSON.parse(match[1]) as Record<string, unknown>
            req.destroy()
            resolve(parsed)
          } catch (error) {
            req.destroy()
            reject(error)
          }
        })
      },
    )
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNRESET' || error.message.includes('aborted')) return
      reject(error)
    })
    req.end()
  })
}

describe('/api/pair routes', () => {
  it('runs the full flow: issue (loopback) → accept (LAN) → cookie → reuse refused', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // The LAN authority cannot issue (loopback-only control plane).
      const lanIssue = await call(port, 'POST', '/api/pair/issue', { host: '192.168.1.5:3080' })
      expect(lanIssue.status).toBe(403)
      // Loopback issues; the URL is the official Web GUI with the token.
      const issued = await call(port, 'POST', '/api/pair/issue', { body: { workspaceId: 'ws-7' } })
      expect(issued.status).toBe(200)
      expect(issued.body.url).toMatch(/^http:\/\/192\.168\.1\.5:3080\/pair-accept\?pair=tok-1$/)
      expect(issued.body.lanAddresses).toEqual(['192.168.1.5'])
      // A LAN phone accepts: sets the HttpOnly device cookie.
      const accepted = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'tok-1' } })
      expect(accepted.status).toBe(200)
      expect(accepted.body).toEqual({ ok: true, deviceId: 'tok-1' })
      expect(accepted.referrerPolicy).toBe('no-referrer')
      expect(accepted.cookies).toEqual([
        'dsh_pair=tok-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000',
      ])
      // The same token stays usable within its window (mobile flows split
      // across cookie contexts): a second accept re-pairs and re-issues the
      // device cookie.
      const reused = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'tok-1' } })
      expect(reused.status).toBe(200)
      expect(reused.body).toEqual({ ok: true, deviceId: 'tok-1' })
      expect(reused.cookies[0]).toMatch(/^dsh_pair=tok-1; Path=\//)
      // The paired cookie heartbeats and reports status.
      const heartbeat = await call(port, 'POST', '/api/pair/heartbeat', { host: '192.168.1.5:3080', cookie: 'dsh_pair=tok-1' })
      expect(heartbeat.status).toBe(200)
      const status = await call(port, 'GET', '/api/pair/status', { host: '192.168.1.5:3080', cookie: 'dsh_pair=tok-1' })
      expect(status.body).toMatchObject({ ok: true, paired: true, phase: 'connected' })
    } finally {
      await close()
    }
  })

  it('/pair-accept lands the paired device on the cookieless app page', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head><title>shell</title></head><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      // The QR link is the /pair-accept entry: mint issues it directly.
      const issued = await call(port, 'POST', '/api/pair/issue', {})
      expect(issued.body.url).toBe('http://192.168.1.5:3080/pair-accept?pair=tok-1')
      const accept = await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080' })
      expect(accept.status).toBe(303)
      // The landing URL carries a one-time grant, never the device id: a
      // session credential must not travel in a URL.
      expect(accept.location).toBe('http://192.168.1.5:3080/pair-app?grant=grant-1')
      expect(accept.cookies).toEqual([
        'dsh_pair=tok-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000',
      ])
      // The paired cookie then passes the heartbeat (device is live).
      const heartbeat = await call(port, 'POST', '/api/pair/heartbeat', { host: '192.168.1.5:3080', cookie: 'dsh_pair=tok-1' })
      expect(heartbeat.status).toBe(200)
      // The app page serves the patched official shell for a live device -
      // no browser cookie needed, the grant rides the URL.
      const app = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080' })
      expect(app.status).toBe(200)
      expect(app.raw).toContain('dsh-remote-device')
      expect(app.raw).toContain('"tok-1"')
      expect(app.raw).toContain('official')
      expect(app.raw).toContain(REMOTE_HOST_GRANT_GLOBAL)
      expect(app.cookies[0]).toMatch(/^dsh_pair=tok-1;/)
      // The grant is single-use: replaying the landing URL resolves to
      // nothing, so a leaked URL cannot re-open the shell.
      const replay = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080' })
      expect(replay.status).toBe(200)
      expect(replay.raw).toContain('refresh the QR code')
      // The retired device query no longer identifies a device at all.
      const legacy = await call(port, 'GET', '/pair-app?device=tok-1', { host: '192.168.1.5:3080' })
      expect(legacy.status).toBe(200)
      expect(legacy.raw).toContain('refresh the QR code')
      // An unknown grant cannot reach the shell.
      const stranger = await call(port, 'GET', '/pair-app?grant=unknown', { host: '192.168.1.5:3080' })
      expect(stranger.status).toBe(200)
      expect(stranger.raw).toContain('refresh the QR code')
      // An invalid token serves the explanation page to an unauthenticated
      // device (a bare `/` redirect would dead-end on the harness 401).
      const bad = await call(port, 'GET', '/pair-accept?pair=dead', { host: '192.168.1.5:3080' })
      expect(bad.status).toBe(200)
      expect(bad.raw).toContain('配对已失效，或配对链接已过期')
      expect(bad.raw).toContain('refresh the QR code')
      expect(bad.cookies ?? []).toEqual([])
      // An already-paired device re-opening a stale (invalid) link goes
      // straight to the app landing with its live device credential.
      const reOpen = await call(port, 'GET', '/pair-accept?pair=dead', { host: '192.168.1.5:3080', cookie: 'dsh_pair=tok-1' })
      expect(reOpen.status).toBe(303)
      expect(reOpen.location).toBe('http://192.168.1.5:3080/pair-app?grant=grant-1')
      expect(reOpen.cookies ?? []).toEqual([])
    } finally {
      await close()
    }
  })

  it('accepts a pairing link opened as a cross-site top-level navigation (in-app browsers)', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head><title>shell</title></head><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      // WeChat and every other WKWebView wrapper label the navigation
      // cross-site and may attach an opaque Origin; the token in the URL is
      // the credential, so the entry pages must still serve it.
      const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site', origin: 'null' }
      const issued = await call(port, 'POST', '/api/pair/issue', {})
      expect(issued.body.url).toBe('http://192.168.1.5:3080/pair-accept?pair=tok-1')
      const accept = await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080', headers: nav })
      expect(accept.status).toBe(303)
      expect(accept.location).toBe('http://192.168.1.5:3080/pair-app?grant=grant-1')
      const app = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080', headers: nav })
      expect(app.status).toBe(200)
      expect(app.raw).toContain('dsh-remote-device')
      // The relaxation is navigation-only: the same markers on a fetch or an
      // iframe keep the fence closed.
      const fetchLike = await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080', headers: { ...nav, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })
      expect(fetchLike.status).toBe(403)
      const iframe = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080', headers: { ...nav, 'sec-fetch-dest': 'iframe' } })
      expect(iframe.status).toBe(403)
      const api = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'tok-1' }, headers: nav })
      expect(api.status).toBe(403)
    } finally {
      await close()
    }
  })

  it('refuses an entry page from an untrusted host without printing to the host console', async () => {
    const service = makeService()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head></head><body>official</body></html>',
    }))
    try {
      // A host outside the service's LAN bases is refused on the entry page,
      // and the refusal stays silent: this plugin keeps the host console clean,
      // so the answer itself is the only observable.
      const headers = { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'cross-site' }
      expect((await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '10.0.0.3:3080', headers })).status).toBe(403)
      expect((await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '10.0.0.3:3080', headers })).status).toBe(403)
      expect(log).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      error.mockRestore()
      warn.mockRestore()
      await close()
    }
  })

  it('re-pairs from the same link in a second context (consumed token stays valid within the window)', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head></head><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      service.issue()
      // First context (camera preview / in-app browser): consumes the
      // token and sets its device cookie.
      const first = await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080' })
      expect(first.status).toBe(303)
      expect(first.location).toBe('http://192.168.1.5:3080/pair-app?grant=grant-1')
      expect(first.cookies[0]).toMatch(/^dsh_pair=tok-1;/)
      // Second context (system browser): the same link within the window
      // completes its own pairing and auth chain - no device cookie needed.
      const second = await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080' })
      expect(second.status).toBe(303)
      expect(second.location).toBe('http://192.168.1.5:3080/pair-app?grant=grant-1')
      expect(second.cookies[0]).toMatch(/^dsh_pair=tok-1;/)
      expect(service.snapshot().deviceCount).toBe(1)
      // The cookieless app landing works with NO cookie at all - only the
      // one-time grant from the URL (the phone case that started all of this).
      const app = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080' })
      expect(app.status).toBe(200)
      expect(app.raw).toContain('official')
      // An expired/unknown link is truly dead: explanation page, no cookie.
      const dead = await call(port, 'GET', '/pair-accept?pair=never-was', { host: '192.168.1.5:3080' })
      expect(dead.status).toBe(200)
      expect(dead.raw).toContain('refresh the QR code')
    } finally {
      await close()
    }
  })

  it('does not register /pair-app without an index provider', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      service.issue()
      await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080' })
      const app = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080' })
      expect(app.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('serves the reopen service worker and registers it from the app shell', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head><title>shell</title></head><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      // The worker script: inert logic served to the phone-facing fence.
      const sw = await call(port, 'GET', PAIR_PATHS.appServiceWorker, {})
      expect(sw.status).toBe(200)
      expect(sw.contentType).toContain('text/javascript')
      expect(sw.cacheControl).toBe('no-store')
      expect(sw.serviceWorkerAllowed).toBe('/')
      // The worker owns navigations to `/` only, network-first through the
      // cookie-authenticated app landing, cached shell as the offline
      // fallback, pass-through when the plugin no longer answers.
      expect(sw.raw).toContain("var APP_URL = '/pair-app'")
      expect(sw.raw).toContain("path !== '/'")
      expect(sw.raw).toContain('caches.open')
      expect(sw.raw).toContain('caches.match')
      expect(sw.raw).toContain('skipWaiting')
      expect(sw.raw).toContain('clients.claim')
      // The app shell registers the worker while the page is open (a live
      // device gets the patched shell; a stranger gets the failure page).
      service.issue()
      await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080' })
      const app = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080' })
      expect(app.raw).toContain('serviceWorker')
      expect(app.raw).toContain(PAIR_PATHS.appServiceWorker)
      // A foreign authority is refused like any phone-facing surface.
      const foreign = await call(port, 'GET', PAIR_PATHS.appServiceWorker, { host: 'evil.example.com' })
      expect(foreign.status).toBe(403)
    } finally {
      await close()
    }
  })

  it('operator: the reopen landing refuses a device without a live pairing', async () => {
    // Given the device-gated landing a plain-HTTP phone now reopens through,
    // and a caller carrying no pairing cookie (a cleared browser, or a
    // device whose pairing was revoked).
    const service = makeService()
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head><title>shell</title></head><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      // When it reopens the landing with no pairing cookie.
      const stranger = await call(port, 'GET', PAIR_PATHS.appPage, { host: '192.168.1.5:3080' })
      // Then the landing answers the bilingual re-pair page and hands out
      // neither the official shell nor the device-capture script: the reopen
      // path is a credential gate, not an open door onto the app.
      expect(stranger.raw).toContain('This pairing has expired or the link is no longer valid.')
      expect(stranger.raw).not.toContain(APP_DEVICE_STORAGE_KEY)
      expect(stranger.raw).not.toContain('<body>official</body>')
    } finally {
      await close()
    }
  })

  it('operator: the landing is handed the other LAN candidates as a hop', async () => {
    // Given a multi-homed host with two LAN literals,
    const service = makeService()
    service.setLanBases([
      { address: '192.168.1.5', base: 'http://192.168.1.5:3080' },
      { address: '10.0.0.3', base: 'http://10.0.0.3:3080' },
    ])
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head><title>shell</title></head><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      // When the desktop issues a link, then it names a LAN base: this plugin
      // has no public entry any more.
      const issued = await call(port, 'POST', '/api/pair/issue', { body: {} })
      expect(issued.body.url).toBe('http://192.168.1.5:3080/pair-accept?pair=tok-1')
      service.issue()
      const accept = await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080' })
      expect(accept.status).toBe(303)
      expect(accept.location).toBe('http://192.168.1.5:3080/pair-app?grant=grant-1')
      // And the landing carries the other literal as a candidate, with a fresh
      // one-time grant for the hop.
      const app = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080' })
      expect(app.status).toBe(200)
      expect(app.raw).toContain(LAN_SOURCE_STORAGE_KEY)
      expect(app.raw).toContain('http://10.0.0.3:3080')
      expect(app.raw).toContain(PAIR_PATHS.ping)
    } finally {
      await close()
    }
  })

  it('operator: a landing already on the LAN origin carries no hop', async () => {
    // Given a single-homed host serving the QR from its own LAN literal, so the
    // phone is on the very origin the probe would have chosen.
    const service = makeService()
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head><title>shell</title></head><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      const issued = await call(port, 'POST', '/api/pair/issue', { body: {} })
      expect(issued.body.url).toBe('http://192.168.1.5:3080/pair-accept?pair=tok-1')
      service.issue()
      await call(port, 'GET', '/pair-accept?pair=tok-1', { host: '192.168.1.5:3080' })
      // When the link is opened and its landing served, then no hop rides along:
      // there is no other candidate to switch to.
      const app = await call(port, 'GET', '/pair-app?grant=grant-1', { host: '192.168.1.5:3080' })
      expect(app.raw).toContain(APP_DEVICE_STORAGE_KEY)
      expect(app.raw).not.toContain(LAN_SOURCE_STORAGE_KEY)
    } finally {
      await close()
    }
  })

  it('guest: the LAN reachability beacon answers our authorities and refuses a foreign host', async () => {
    // Given the beacon the landing probes, our own LAN authority, a foreign
    // authority, and the cross-site marker shape the probe itself produces,
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When each asks, then our authority answers 204 (the marker check is
      // deliberately not applied, or every probe would read as a refusal) and the
      // foreign Host is refused.
      const mine = await call(port, 'GET', PAIR_PATHS.ping, { host: '192.168.1.5:3080' })
      expect(mine.status).toBe(204)
      expect(mine.cacheControl).toBe('no-store')
      // A cross-site probe is the only shape the landing can produce; it must
      // still read as "this origin answers", not as the fence's refusal.
      const probe = await call(port, 'GET', PAIR_PATHS.ping, { host: '192.168.1.5:3080', headers: { origin: 'https://relay.example.com', 'sec-fetch-site': 'cross-site' } })
      expect(probe.status).toBe(204)
      const foreign = await call(port, 'GET', PAIR_PATHS.ping, { host: 'evil.example.com' })
      expect(foreign.status).toBe(403)
    } finally {
      await close()
    }
  })

  it('does not register the reopen worker without an app landing', async () => {
    const { port, close } = await serve(makeRoutes({ service: makeService() }))
    try {
      const missing = await call(port, 'GET', PAIR_PATHS.appServiceWorker, {})
      expect(missing.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('refuses unknown/expired tokens and unpaired heartbeats', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const bad = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'nope' } })
      expect(bad.status).toBe(404)
      const noCookie = await call(port, 'POST', '/api/pair/heartbeat', { host: '192.168.1.5:3080' })
      expect(noCookie.status).toBe(401)
    } finally {
      await close()
    }
  })

  it('issues against a requested LAN address and refuses unknown literals', async () => {
    const service = makeService()
    service.setLanBases([
      { address: '192.168.1.5', base: 'http://192.168.1.5:3080' },
      { address: '10.0.0.3', base: 'http://10.0.0.3:3080' },
    ])
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const chosen = await call(port, 'POST', '/api/pair/issue', { body: { address: '10.0.0.3' } })
      expect(chosen.status).toBe(200)
      expect(chosen.body.url).toMatch(/^http:\/\/10\.0\.0\.3:3080\/pair-accept\?pair=tok-1$/)
      expect(chosen.body.lanAddresses).toEqual(['192.168.1.5', '10.0.0.3'])
      const unknown = await call(port, 'POST', '/api/pair/issue', { body: { address: '192.0.2.1' } })
      expect(unknown.status).toBe(400)
      expect(unknown.body.code).toBe('unknown-address')
    } finally {
      await close()
    }
  })

  it('stop revokes devices and the token from the control plane', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const issued = await call(port, 'POST', '/api/pair/issue', {})
      const token = issued.body.token as string
      await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token } })
      const stopped = await call(port, 'POST', '/api/pair/stop', {})
      expect(stopped.status).toBe(200)
      // The consumed token cannot be re-accepted after stop (invalid, not used).
      const after = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token } })
      expect(after.status).toBe(404)
      // The paired cookie no longer heartbeats.
      const heartbeat = await call(port, 'POST', '/api/pair/heartbeat', { host: '192.168.1.5:3080', cookie: `dsh_pair=${token}` })
      expect(heartbeat.status).toBe(401)
    } finally {
      await close()
    }
  })

  it('reports lan-required without a LAN bind (no dead QR)', async () => {
    const service = makeService()
    service.setLanBases([])
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const issued = await call(port, 'POST', '/api/pair/issue', {})
      expect(issued.status).toBe(409)
      expect(issued.body.code).toBe('lan-required')
    } finally {
      await close()
    }
  })

  it('operator: the device cookie is Secure only when the request arrived over TLS', async () => {
    // Given a live pairing token and a server reachable both ways.
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      service.issue()
      // When a LAN phone pairs over plain HTTP and a tunneled phone pairs over
      // TLS (the edge stamps x-forwarded-proto).
      const lan = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'tok-1' } })
      const tls = await call(port, 'POST', '/api/pair/accept', {
        host: '192.168.1.5:3080',
        body: { token: 'tok-1' },
        headers: { 'x-forwarded-proto': 'https' },
      })
      // Then the Secure attribute follows the transport: off on LAN HTTP,
      // where a Secure cookie would simply be dropped by the browser.
      expect(lan.cookies[0]).toBe('dsh_pair=tok-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000')
      expect(tls.cookies[0]).toBe('dsh_pair=tok-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure')
    } finally {
      await close()
    }
  })

  it('operator: the device-capture script lands ahead of the parse-time boot patch', () => {
    // Given the official shell as the harness injects it, boot patch first.
    const html = '<html><head><script>BOOT_PATCH</script></head><body></body></html>'
    // When the device-gated landing patches in its capture script.
    const patched = patchAppShell(html, 'dev-1')
    const captureAt = patched.indexOf('dsh-remote-device')
    const bootAt = patched.indexOf('BOOT_PATCH')
    // Then the capture script precedes the boot patch: host mode is
    // server-granted, so the marker must exist before the patch reads it.
    expect(captureAt).toBeGreaterThan(-1)
    expect(bootAt).toBeGreaterThan(-1)
    expect(captureAt).toBeLessThan(bootAt)
    expect(patched).toContain(REMOTE_HOST_GRANT_GLOBAL)
    expect(patched).toContain('"dev-1"')
  })

  it('operator gets a LAN URL from issue and no public base in the response', async () => {
    // Given a host whose only reachable authority is its own LAN literal, so
    // the QR names http://192.168.1.100:3080/pair-accept?pair=<token>
    const service = makeService()
    service.setLanBases([{ address: '192.168.1.100', base: 'http://192.168.1.100:3080' }])
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When the desktop mints a pairing link
      const issued = await call(port, 'POST', '/api/pair/issue', {})
      // Then the advertised URL is the LAN entry, and the response carries no
      // public base: this plugin has no public access path any more
      expect(issued.status).toBe(200)
      expect(issued.body.url).toBe('http://192.168.1.100:3080/pair-accept?pair=tok-1')
      expect(issued.body).not.toHaveProperty('publicBaseUrl')
      expect(issued.body.lanAddresses).toEqual(['192.168.1.100'])
      // A LAN origin cannot mint the QR (loopback-only control plane).
      const lanIssue = await call(port, 'POST', '/api/pair/issue', { host: '192.168.1.100:3080', body: {} })
      expect(lanIssue.status).toBe(403)
      expect(lanIssue.body).toEqual({ ok: false, code: 'forbidden' })
      // An explicit LAN address still mints that literal's URL.
      const chosen = await call(port, 'POST', '/api/pair/issue', { body: { address: '192.168.1.100' } })
      expect(chosen.body.url).toBe('http://192.168.1.100:3080/pair-accept?pair=tok-1')
    } finally {
      await close()
    }
  })

  it('publishes the live desktop gate policy without exposing sensitive state', async () => {
    const service = makeService()
    let requirePairingForLan = false
    const { port, close } = await serve(makeRoutes({
      service,
      requirePairingForLan: () => requirePairingForLan,
    }))
    try {
      const disabled = await call(port, 'GET', '/api/pair/status', { host: '192.168.1.5:3080' })
      expect(disabled.body).toMatchObject({ ok: true, paired: false, requirePairingForLan: false })
      requirePairingForLan = true
      const enabled = await call(port, 'GET', '/api/pair/status', { host: '192.168.1.5:3080' })
      expect(enabled.body).toMatchObject({ ok: true, paired: false, requirePairingForLan: true })
      expect(enabled.body).not.toHaveProperty('deviceCount')
    } finally {
      await close()
    }
  })

  it('redacts the pairing oracle fields from unpaired status callers', async () => {
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // No cookie: only pairing-relevant fields, no token/device oracle.
      const unpaired = await call(port, 'GET', '/api/pair/status', { host: '192.168.1.5:3080' })
      expect(unpaired.status).toBe(200)
      expect(unpaired.body).toMatchObject({ ok: true, paired: false, requirePairingForLan: true, phase: 'waiting', lanAvailable: true })
      expect(unpaired.body).not.toHaveProperty('tokenId')
      expect(unpaired.body).not.toHaveProperty('tokenExpiresAt')
      expect(unpaired.body).not.toHaveProperty('deviceCount')
      expect(unpaired.body).not.toHaveProperty('onlineCount')
      expect(unpaired.body).not.toHaveProperty('publicUrl')
      // A live device cookie sees the full snapshot.
      await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'tok-1' } })
      const paired = await call(port, 'GET', '/api/pair/status', { host: '192.168.1.5:3080', cookie: 'dsh_pair=tok-1' })
      expect(paired.body).toMatchObject({ ok: true, paired: true, phase: 'connected' })
      expect(paired.body).toHaveProperty('deviceCount')
      expect(paired.body).toHaveProperty('onlineCount')
      expect(paired.body).toHaveProperty('tokenExpiresAt')
    } finally {
      await close()
    }
  })

  it('operator is protected from a rotated XFF prefix minting fresh accept budgets', async () => {
    // Given a pairing server whose requests arrive through the tunnel edge.
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When one client rotates the hop it prepends while the edge-appended
      // hop stays constant (the edge APPENDS the address it saw; only that hop
      // is trusted, so the bucket cannot be rotated).
      for (let index = 0; index < 10; index += 1) {
        const attempt = await call(port, 'POST', '/api/pair/accept', {
          host: '192.168.1.5:3080',
          body: { token: 'nope' },
          headers: { 'x-forwarded-for': '10.0.0.' + String(index) + ', 198.51.100.7' },
        })
        expect(attempt.status).not.toBe(429)
      }
      const limited = await call(port, 'POST', '/api/pair/accept', {
        host: '192.168.1.5:3080',
        body: { token: 'nope' },
        headers: { 'x-forwarded-for': '10.0.0.250, 198.51.100.7' },
      })
      // Then every attempt counted against the one edge-appended client.
      expect(limited.status).toBe(429)
    } finally {
      await close()
    }
  })

  it('partitions the accept rate-limit buckets by the client-visible XFF hop', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // Distinct XFF clients each get their own bucket: none trips the limit.
      for (let index = 0; index < 12; index += 1) {
        const attempt = await call(port, 'POST', '/api/pair/accept', {
          host: '192.168.1.5:3080',
          body: { token: 'nope' },
          headers: { 'x-forwarded-for': '203.0.113.' + String(index) },
        })
        expect(attempt.status).not.toBe(429)
      }
      // One client exhausting its bucket is rate-limited from attempt 12 on.
      for (let index = 0; index < 11; index += 1) {
        await call(port, 'POST', '/api/pair/accept', {
          host: '192.168.1.5:3080',
          body: { token: 'nope' },
          headers: { 'x-forwarded-for': '198.51.100.7' },
        })
      }
      const limited = await call(port, 'POST', '/api/pair/accept', {
        host: '192.168.1.5:3080',
        body: { token: 'nope' },
        headers: { 'x-forwarded-for': '198.51.100.7' },
      })
      expect(limited.status).toBe(429)
    } finally {
      await close()
    }
  })

  it('operator behind a reverse proxy is refused the loopback-only control planes', async () => {
    // Given a pairing server reached by a proxy that dials 127.0.0.1: the
    // socket is loopback and the rewritten Host matches the upstream literal,
    // which is exactly what a Cloudflare tunnel, frp or nginx produces.
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const loopbackHost = '127.0.0.1:' + String(port)
      // When the forwarded request reaches the control plane
      const issueViaCf = await call(port, 'POST', '/api/pair/issue', {
        host: loopbackHost,
        body: {},
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      })
      const issueViaXff = await call(port, 'POST', '/api/pair/issue', {
        host: loopbackHost,
        body: {},
        headers: { 'x-forwarded-for': '203.0.113.7' },
      })
      const stopViaXff = await call(port, 'POST', '/api/pair/stop', {
        host: loopbackHost,
        body: {},
        headers: { 'x-forwarded-for': '203.0.113.7' },
      })
      // Then every one of them fails the loopback fence
      expect(issueViaCf.status).toBe(403)
      expect(issueViaCf.body).toMatchObject({ ok: false, code: 'forbidden' })
      expect(issueViaXff.status).toBe(403)
      expect(stopViaXff.status).toBe(403)
      // And the same calls without a forwarding header still serve the desktop.
      const direct = await call(port, 'POST', '/api/pair/issue', { host: loopbackHost, body: {} })
      expect(direct.status).toBe(200)
    } finally {
      await close()
    }
  })

  it('operator behind a reverse proxy gets the minimal view, never the desktop snapshot', async () => {
    // Given a running pairing service advertising its LAN literals
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const loopbackHost = '127.0.0.1:' + String(port)
      // When a forwarded caller that looks loopback asks for the status
      const forwarded = await call(port, 'GET', '/api/pair/status', {
        host: loopbackHost,
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      })
      // Then the phone-facing surface answers it (a forwarded pairing flow has
      // to read this, issue #1919) but the Host it presents is the proxy's own
      // upstream literal, i.e. a rewritten loopback upstream rather than the
      // desktop, so only the minimal payload comes back.
      expect(forwarded.status).toBe(200)
      expect(forwarded.body).toEqual({
        ok: true,
        paired: false,
        requirePairingForLan: true,
        phase: 'waiting',
        lanAvailable: true,
      })
      // The direct desktop call still gets the full pairing-relevant view.
      const direct = await call(port, 'GET', '/api/pair/status', { host: loopbackHost })
      expect(direct.status).toBe(200)
      expect(direct.body).toHaveProperty('tokenExpiresAt')
      // A proxy that passes a served LAN authority through reaches the same
      // minimal view: a forwarded caller is never the desktop.
      const viaLanHost = await call(port, 'GET', '/api/pair/status', {
        host: '192.168.1.5:3080',
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      })
      expect(viaLanHost.status).toBe(200)
      expect(viaLanHost.body).toMatchObject({ ok: true, paired: false })
      expect(viaLanHost.body).not.toHaveProperty('tokenExpiresAt')
    } finally {
      await close()
    }
  })

  it('rejects non-GET/POST methods with 405', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const status = await call(port, 'GET', '/api/pair/issue', {})
      expect(status.status).toBe(405)
    } finally {
      await close()
    }
  })

  it('malformed payloads are refused with the existing error shape', async () => {
    const service = makeService()
    service.setLanBases([{ address: '192.168.1.5', base: 'http://192.168.1.5:3080' }])
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const badIssue = await call(port, 'POST', '/api/pair/issue', { body: { address: 42 } })
      expect(badIssue.status).toBe(400)
      expect(badIssue.body).toEqual({ ok: false, code: 'bad-payload' })
      const badAccept = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 7 } })
      expect(badAccept.status).toBe(400)
      expect(badAccept.body).toEqual({ ok: false, code: 'bad-payload' })
    } finally {
      await close()
    }
  })

  it('omits the device roster from status even for a paired cookie', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      await call(port, 'POST', '/api/pair/issue', {})
      await call(port, 'POST', '/api/pair/accept', {
        host: '192.168.1.5:3080',
        body: { token: 'tok-1' },
        headers: { 'user-agent': 'Mozilla/5.0 TestPhone' },
      })
      const status = await call(port, 'GET', '/api/pair/status', { host: '192.168.1.5:3080', cookie: 'dsh_pair=tok-1' })
      expect(status.body).toMatchObject({ ok: true, paired: true, deviceCount: 1 })
      expect(status.body).not.toHaveProperty('devices')
    } finally {
      await close()
    }
  })

  it('pushes the device roster on the loopback events stream', async () => {
    const service = makeService()
    service.issue()
    service.accept('tok-1', 'Mozilla/5.0 TestPhone')
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const frame = await readFirstSse(port, '/api/pair/events')
      expect(frame.type).toBe('state')
      expect(frame.devices).toEqual([
        expect.objectContaining({ id: 'tok-1', online: true, userAgent: 'Mozilla/5.0 TestPhone' }),
      ])
    } finally {
      await close()
    }
  })

  it('serves the loopback-only lan-bind status endpoint and hides it without a provider', async () => {
    const service = makeService()
    const calls: string[] = []
    const { port, close } = await serve(makeRoutes({
      service,
      lanBindStatus: () => {
        calls.push('read')
        // The 0.2.1-rc.2 shape: the wildcard is refused, so the block pins a
        // concrete address and the four capability fields ride along (#1893).
        return {
          profile: 'web',
          setting: true,
          blockHost: '192.168.1.5',
          bindHost: '192.168.1.5',
          port,
          lanUrls: [`http://192.168.1.5:${String(port)}`],
          firewall: { ok: true, managed: false },
          platform: 'darwin',
          pendingRestart: false,
          desiredHost: '192.168.1.5',
          wildcardSupported: false,
          supportedHosts: ['192.168.1.5'],
          lanBlocked: false,
        }
      },
    }))
    try {
      // Loopback reads the live facts; the read count pins the per-request
      // (uncached) contract the card's 10s poll relies on.
      const ok = await call(port, 'GET', PAIR_PATHS.lanBind, {})
      expect(ok.status).toBe(200)
      expect(ok.body).toMatchObject({
        ok: true,
        profile: 'web',
        blockHost: '192.168.1.5',
        bindHost: '192.168.1.5',
        desiredHost: '192.168.1.5',
        wildcardSupported: false,
        supportedHosts: ['192.168.1.5'],
        lanBlocked: false,
      })
      expect(calls).toHaveLength(1)
      // A LAN origin is refused: the endpoint exposes host/network facts.
      const lan = await call(port, 'GET', PAIR_PATHS.lanBind, { host: '192.168.1.5:3080' })
      expect(lan.status).toBe(403)
      // POST is not the contract.
      const wrongMethod = await call(port, 'POST', PAIR_PATHS.lanBind, { body: {} })
      expect(wrongMethod.status).toBe(405)
    } finally {
      await close()
    }
    // Without the provider the route is not registered at all.
    const bare = await serve(makeRoutes({ service: makeService() }))
    try {
      const missing = await call(bare.port, 'GET', PAIR_PATHS.lanBind, {})
      expect(missing.status).toBe(404)
    } finally {
      await bare.close()
    }
  })

  it('counts the accept page and the accept API in separate rate-limit buckets', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // Exhaust the API bucket with token-guessing POSTs.
      for (let index = 0; index < 11; index += 1) {
        await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'nope' } })
      }
      const apiLimited = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'nope' } })
      expect(apiLimited.status).toBe(429)
      // The page bucket is untouched: QR navigations still answer.
      const page = await call(port, 'GET', '/pair-accept?pair=dead', { host: '192.168.1.5:3080' })
      expect(page.status).toBe(200)
      // Exhausting the page bucket afterwards does not un-limit the API.
      for (let index = 0; index < 12; index += 1) {
        await call(port, 'GET', '/pair-accept?pair=dead', { host: '192.168.1.5:3080' })
      }
      const pageLimited = await call(port, 'GET', '/pair-accept?pair=dead', { host: '192.168.1.5:3080' })
      expect(pageLimited.status).toBe(429)
      const apiStillLimited = await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'nope' } })
      expect(apiStillLimited.status).toBe(429)
    } finally {
      await close()
    }
  })

  it('keys the rate limiter: XFF partitions only for loopback peers', () => {
    // Tunnel edge (loopback peer): the XFF hop separates buckets.
    expect(acceptLimitKey('127.0.0.1', '203.0.113.9', 'api')).toBe('api|127.0.0.1|203.0.113.9')
    expect(acceptLimitKey('::ffff:127.0.0.1', '203.0.113.9', 'page')).toBe('page|::ffff:127.0.0.1|203.0.113.9')
    // Direct LAN peer: a rotatable header must not mint fresh buckets.
    expect(acceptLimitKey('192.168.1.50', '203.0.113.9', 'api')).toBe('api|192.168.1.50')
    expect(acceptLimitKey('192.168.1.50', undefined, 'api')).toBe('api|192.168.1.50')
    // Missing/blank XFF collapses onto the socket bucket.
    expect(acceptLimitKey('127.0.0.1', '', 'api')).toBe('api|127.0.0.1')
  })

  it('bounds the dynamic trusted-host table (FIFO eviction, idempotent re-add)', () => {
    const set = new Set<string>()
    addBounded(set, '10.0.0.1:3080', 3)
    addBounded(set, '10.0.0.2:3080', 3)
    // A repeat insert must not evict or reorder anything.
    addBounded(set, '10.0.0.1:3080', 3)
    addBounded(set, '10.0.0.3:3080', 3)
    expect([...set]).toEqual(['10.0.0.1:3080', '10.0.0.2:3080', '10.0.0.3:3080'])
    // Past the cap the OLDEST entry goes, so the table never exceeds max.
    addBounded(set, '10.0.0.4:3080', 3)
    expect([...set]).toEqual(['10.0.0.2:3080', '10.0.0.3:3080', '10.0.0.4:3080'])
    addBounded(set, '10.0.0.5:3080', 3)
    expect(set.size).toBe(3)
    expect([...set]).toEqual(['10.0.0.3:3080', '10.0.0.4:3080', '10.0.0.5:3080'])
    // The shipped cap holds under a Host-header flood.
    const flooded = new Set<string>()
    for (let i = 0; i < MAX_DYNAMIC_TRUSTED_HOSTS * 4; i += 1) addBounded(flooded, `host-${String(i)}.lan`, MAX_DYNAMIC_TRUSTED_HOSTS)
    expect(flooded.size).toBe(MAX_DYNAMIC_TRUSTED_HOSTS)
    expect(flooded.has('host-0.lan')).toBe(false)
    expect(flooded.has(`host-${String(MAX_DYNAMIC_TRUSTED_HOSTS * 4 - 1)}.lan`)).toBe(true)
  })

  it('revokes one device from loopback and refuses LAN revoke', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      await call(port, 'POST', '/api/pair/issue', {})
      await call(port, 'POST', '/api/pair/accept', { host: '192.168.1.5:3080', body: { token: 'tok-1' } })
      const lanRevoke = await call(port, 'POST', '/api/pair/revoke', {
        host: '192.168.1.5:3080',
        body: { deviceId: 'tok-1' },
      })
      expect(lanRevoke.status).toBe(403)
      expect(service.hasDevice('tok-1')).toBe(true)
      const revoked = await call(port, 'POST', '/api/pair/revoke', { body: { deviceId: 'tok-1' } })
      expect(revoked.status).toBe(200)
      expect(service.hasDevice('tok-1')).toBe(false)
      const missing = await call(port, 'POST', '/api/pair/revoke', { body: { deviceId: 'tok-1' } })
      expect(missing.status).toBe(404)
    } finally {
      await close()
    }
  })
})
describe('/api/pair body failure contract (shared readJsonBody)', () => {
  /** Raw POST with no JSON encoding: malformed text, or no payload at all. */
  async function rawPost(
    port: number,
    path: string,
    payload: string | undefined,
  ): Promise<{ status: number | null; body: string; error: string | null }> {
    return await new Promise((resolve) => {
      const headers: Record<string, string> = { host: '127.0.0.1:' + String(port), connection: 'close' }
      if (payload !== undefined) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = String(Buffer.byteLength(payload))
      }
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => { chunks.push(chunk as Buffer) })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), error: null })
        })
      })
      req.on('error', (error: Error) => resolve({ status: null, body: '', error: error.message }))
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  it('locks the lenient absent-body contract: empty or unparseable bodies act as an empty object', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // stopPair() and sendHeartbeat() post with no body at all.
      const stop = await call(port, 'POST', '/api/pair/stop', {})
      expect(stop.status).toBe(200)
      expect(stop.body).toEqual({ ok: true })
      const heartbeat = await call(port, 'POST', '/api/pair/heartbeat', {})
      expect(heartbeat.status).toBe(401)
      // An unparseable body is treated the same as an absent one.
      const issue = await rawPost(port, '/api/pair/issue', '{not json')
      expect(issue.status).toBe(200)
      expect(issue.body).toContain('"token":"tok-1"')
      const revoke = await rawPost(port, '/api/pair/revoke', '{not json')
      expect(revoke.status).toBe(400)
      expect(JSON.parse(revoke.body)).toEqual({ ok: false, code: 'bad-payload' })
      // objectOnly: a JSON array is read as null and therefore absent.
      const array = await call(port, 'POST', '/api/pair/issue', { body: [1, 2] })
      expect(array.status).toBe(200)
    } finally {
      await close()
    }
  })

  it('locks the oversize contract: the shared reader destroys the request instead of answering', async () => {
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      const outcome = await rawPost(port, '/api/pair/issue', JSON.stringify({ address: 'x'.repeat(5000) }))
      expect(outcome.status).toBeNull()
      expect(outcome.error).toMatch(/socket hang up|ECONNRESET/)
    } finally {
      await close()
    }
  })

  it('operator does not disclose the LAN literals to an unpaired caller', async () => {
    // Given a paired-capable server with one live token and no device cookie.
    const service = makeService()
    service.issue()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When an unpaired tunnel/LAN caller reads the status.
      const remote = await call(port, 'GET', '/api/pair/status', { host: '192.168.1.5:3080' })
      // Then only the pairing-relevant fields come back: the private network
      // layout stays behind a live pairing or the loopback desktop.
      expect(remote.status).toBe(200)
      expect(remote.body).toMatchObject({ paired: false, phase: 'waiting', lanAvailable: true })
      expect(remote.body).not.toHaveProperty('lanAddresses')
      // And the loopback desktop still sees them (its panel lists the literals).
      const local = await call(port, 'GET', '/api/pair/status', { host: '127.0.0.1:' + String(port) })
      expect(local.body.lanAddresses).toEqual(['192.168.1.5'])
    } finally {
      await close()
    }
  })

  it('operator keeps pairing reachable with a malformed trusted-host entry', () => {
    // Given a non-loopback pairing request and a config/env typo in the
    // trusted-host list (here an unclosed IPv6 literal).
    const request = {
      headers: { host: 'proxy.example:3080' },
      socket: { remoteAddress: '192.168.1.9' },
    } as unknown as import('node:http').IncomingMessage
    // When the fence consults the list, then the typo contributes no trust
    // instead of throwing out of the handler (which used to make every
    // non-loopback pairing request answer 400) and the valid entry still works.
    expect(isTrustedHost(request, ['[fe80::1'])).toBe(false)
    expect(isTrustedHost(request, ['[fe80::1', 'proxy.example:3080'])).toBe(true)
  })
})

/**
 * A proxying front end (a reverse proxy, frp, or an operator's own tunnel)
 * dials 127.0.0.1:<port> and rewrites the Host to that upstream literal, so the
 * phone-facing surface has to answer the visitor (#1919 was the 403 storm: no
 * pairing page, no status, a blank phone) while the desktop payload and every
 * credential-bearing control plane stay behind the strict no-forwarding-header
 * classification (#1906 stays shut).
 */
describe('forwarded mobile pairing (issue #1919)', () => {
  /** What a proxy stamps on a request it forwards to the loopback upstream. */
  const tunnelHeaders = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' }
  /** The shape a phone's top-level navigation to a pairing link takes. */
  const navigationMarkers = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

  it('guest: the forwarded phone reads the minimal pairing status', async () => {
    // Given a pairing service with a live token
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When a proxying front end forwards the request with its Host rewritten
      // to the loopback upstream
      const status = await call(port, 'GET', PAIR_PATHS.status, {
        host: '127.0.0.1:' + String(port),
        headers: tunnelHeaders,
      })
      // Then the phone is answered with the minimal payload only: no device
      // roster, no token, no LAN layout.
      expect(status.status).toBe(200)
      expect(status.body).toEqual({
        ok: true,
        paired: false,
        requirePairingForLan: true,
        phase: 'waiting',
        lanAvailable: true,
      })
    } finally {
      await close()
    }
  })

  it('guest: every credential control plane stays refused behind a proxy', async () => {
    // Given a pairing server behind a Host-rewriting proxy
    const service = makeService()
    const { port, close } = await serve(makeRoutes({
      service,
      lanBindStatus: () => ({ bindHost: '192.168.1.5' }),
    }))
    try {
      const loopbackHost = '127.0.0.1:' + String(port)
      // When the tunnel-forwarded caller asks each control plane
      const issue = await call(port, 'POST', PAIR_PATHS.issue, { host: loopbackHost, body: {}, headers: tunnelHeaders })
      const lanBind = await call(port, 'GET', PAIR_PATHS.lanBind, { host: loopbackHost, headers: tunnelHeaders })
      const revoke = await call(port, 'POST', PAIR_PATHS.revoke, { host: loopbackHost, body: { deviceId: 'tok-1' }, headers: tunnelHeaders })
      const stop = await call(port, 'POST', PAIR_PATHS.stop, { host: loopbackHost, body: {}, headers: tunnelHeaders })
      // Then minting, revoking, stopping and the LAN-bind facts all stay refused
      expect(issue.status).toBe(403)
      expect(issue.body).toEqual({ ok: false, code: 'forbidden' })
      expect(lanBind.status).toBe(403)
      expect(revoke.status).toBe(403)
      expect(stop.status).toBe(403)
      // And the desktop, which presents no forwarding header, still has them.
      const desktopIssue = await call(port, 'POST', PAIR_PATHS.issue, { host: loopbackHost, body: {} })
      const desktopLanBind = await call(port, 'GET', PAIR_PATHS.lanBind, { host: loopbackHost })
      expect(desktopIssue.status).toBe(200)
      expect(desktopLanBind.status).toBe(200)
    } finally {
      await close()
    }
  })

  it('guest: the desktop events stream stays refused behind a proxy', async () => {
    // Given a pairing service whose device roster rides the loopback stream
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When the forwarded caller opens the stream
      const stream = await call(port, 'GET', PAIR_PATHS.events, {
        host: '127.0.0.1:' + String(port),
        headers: tunnelHeaders,
      })
      // Then it is refused instead of streaming the roster
      expect(stream.status).toBe(403)
      expect(stream.body).toEqual({ ok: false, code: 'forbidden' })
    } finally {
      await close()
    }
  })

  it('operator: the desktop keeps the full pairing snapshot without a forwarding header', async () => {
    // Given a pairing service with a token
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When the desktop panel asks over plain loopback
      const status = await call(port, 'GET', PAIR_PATHS.status, { host: '127.0.0.1:' + String(port) })
      // Then it keeps the full pairing-relevant view
      expect(status.status).toBe(200)
      expect(status.body).toMatchObject({ ok: true, paired: false, deviceCount: 0, onlineCount: 0 })
      expect(status.body).toHaveProperty('tokenExpiresAt')
      expect(status.body).toHaveProperty('lanAddresses', ['192.168.1.5'])
      // The per-device roster never leaves through status, not even here.
      expect(status.body).not.toHaveProperty('devices')
      // And no public surface is advertised at all.
      expect(status.body).not.toHaveProperty('publicUrl')
    } finally {
      await close()
    }
  })

  it('guest: a forwarded accept carrying a served Origin is allowed', async () => {
    // Given a pairing service that serves one LAN authority
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When the page on that served origin posts the accept through a proxy
      // (Host rewritten to the loopback upstream, Origin still the served one)
      const accepted = await call(port, 'POST', PAIR_PATHS.accept, {
        host: '127.0.0.1:' + String(port),
        body: { token: 'tok-1' },
        headers: { ...tunnelHeaders, origin: 'http://192.168.1.5:3080' },
      })
      // Then the same-origin page is allowed and gets the device cookie
      expect(accepted.status).toBe(200)
      expect(accepted.body).toEqual({ ok: true, deviceId: 'tok-1' })
      expect(accepted.cookies[0]).toMatch(/^dsh_pair=tok-1;/)
    } finally {
      await close()
    }
  })

  it('guest: a forwarded accept carrying a stranger Origin is refused', async () => {
    // Given a pairing service that serves one LAN authority
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When some other site's page posts the accept through the same proxy
      const stranger = await call(port, 'POST', PAIR_PATHS.accept, {
        host: '127.0.0.1:' + String(port),
        body: { token: 'tok-1' },
        headers: { ...tunnelHeaders, origin: 'https://evil.example.net' },
      })
      // Then the origin fence refuses it: only served authorities, never any
      expect(stranger.status).toBe(403)
      expect(stranger.body).toEqual({ ok: false, code: 'forbidden' })
      expect(stranger.cookies).toEqual([])
    } finally {
      await close()
    }
  })

  it('guest: a served-authority Origin is refused unless a proxy forwarded it onto the loopback upstream', async () => {
    // Given a request whose Host is a served LAN literal (no rewritten upstream)
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When it presents another served authority as its Origin
      const mismatched = await call(port, 'POST', PAIR_PATHS.accept, {
        host: '10.0.0.3:3080',
        body: { token: 'tok-1' },
        headers: { origin: 'http://192.168.1.5:3080' },
      })
      // Then the equality assertion still holds: an unserved Host is refused
      // outright by the reachability fence.
      expect(mismatched.status).toBe(403)
      // And a direct desktop request claiming a served LAN origin is refused
      // too: no proxy forwarded it, so Origin must equal Host.
      const desktopClaim = await call(port, 'POST', PAIR_PATHS.accept, {
        host: '127.0.0.1:' + String(port),
        body: { token: 'tok-1' },
        headers: { origin: 'http://192.168.1.5:3080' },
      })
      expect(desktopClaim.status).toBe(403)
    } finally {
      await close()
    }
  })

  it('guest: a forwarded phone walks from the pairing link to the rendered shell', async () => {
    // Given a pairing service, an app shell and a grant table
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><head><title>shell</title></head><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      const loopbackHost = '127.0.0.1:' + String(port)
      // When the phone opens the QR link through the proxy
      const accept = await call(port, 'GET', PAIR_PATHS.acceptPage + '?pair=tok-1', {
        host: loopbackHost,
        headers: { ...tunnelHeaders, ...navigationMarkers },
      })
      // Then the entry page answers and redirects to the authority the request
      // presented (there is no public base to redirect to any more).
      expect(accept.status).toBe(303)
      expect(accept.location).toBe('https://' + loopbackHost + '/pair-app?grant=grant-1')
      expect(accept.cookies[0]).toMatch(/^dsh_pair=tok-1;.*; Secure$/)
      // And the landing renders the patched official shell for that device.
      const app = await call(port, 'GET', PAIR_PATHS.appPage + '?grant=grant-1', {
        host: loopbackHost,
        headers: { ...tunnelHeaders, ...navigationMarkers },
      })
      expect(app.status).toBe(200)
      expect(app.raw).toContain('dsh-remote-device')
      expect(app.raw).toContain('official')
    } finally {
      await close()
    }
  })

  it('operator: the desktop redirect stays on its own authority', async () => {
    // Given the same service, opened from the desktop with no forwarding header
    const service = makeService()
    service.issue('ws-7', undefined)
    const { port, close } = await serve(makeRoutes({
      service,
      indexDocument: async () => '<html><body>official</body></html>',
      grants: makeGrants(),
    }))
    try {
      const loopbackHost = '127.0.0.1:' + String(port)
      // When the desktop follows the same entry page
      const accept = await call(port, 'GET', PAIR_PATHS.acceptPage + '?pair=tok-1', { host: loopbackHost })
      // Then the redirect stays on the authority the desktop actually reached
      expect(accept.status).toBe(303)
      expect(accept.location).toBe('http://' + loopbackHost + '/pair-app?grant=grant-1')
    } finally {
      await close()
    }
  })

  it('guest: the LAN reachability beacon answers through a proxy', async () => {
    // Given a pairing service behind a proxying front end
    const service = makeService()
    const { port, close } = await serve(makeRoutes({ service }))
    try {
      // When the beacon is probed from the rewritten authority
      const ping = await call(port, 'GET', PAIR_PATHS.ping, {
        host: '127.0.0.1:' + String(port),
        headers: { ...tunnelHeaders, 'sec-fetch-site': 'cross-site' },
      })
      // Then it answers: the probe is cross-site by construction and is the
      // signal that decides which LAN source a phone keeps.
      expect(ping.status).toBe(204)
    } finally {
      await close()
    }
  })
})
