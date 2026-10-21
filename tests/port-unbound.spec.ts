/**
 * The 0.2.1-rc.2 webServer type leaves `ctx.webServer.port` undefined until
 * the listener binds (a recompose pass can run this apply ahead of the bind).
 * The host half must degrade honestly in that window: the loopback proxies
 * refuse with 503 (remote-api.spec.ts / remote-upgrade.spec.ts), the LAN bases
 * stay unadvertised (`lanBasesOf` needs a port), and the LAN forwarder is not
 * planned against an undefined port. This file pins those guards inside
 * applyImpl, the same source-body idiom as lan-bind-hmr-nesting.spec.ts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/**
 * The body of one top-level const declaration inside applyImpl, found by brace
 * balance from its opening brace.
 * @param name - the local const's name.
 * @returns the function body source, without the closing brace.
 */
function bodyOf(name: string): string {
  const head = new RegExp('const ' + name + ' = \\([^)]*\\): void => \\{')
  const match = head.exec(source)
  if (match === null) throw new Error('no ' + name + ' declaration in src/index.ts')
  const start = match.index + match[0].length - 1
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  throw new Error('unbalanced braces after ' + name)
}

describe('webServer port unsettled (0.2.1-rc.2)', () => {
  it('operator leaves the LAN bases alone while the port is unbound', () => {
    // Given the boot-time LAN base sampling, whose base URLs need the port
    // When the port has not settled yet
    // Then both facts are required before anything is advertised, so a
    // recompose pass cannot mint http://<lan>:undefined links or clear a
    // working set
    expect(source).toContain('const bindKnown = typeof ctx.webServer.host === \'string\' && ctx.webServer.host !== \'\'')
    expect(source).toContain('&& Number.isFinite(ctx.webServer.port)')
    expect(source).toContain('service.setLanBases(lanBasesOf(ctx.webServer.host, ctx.webServer.port as number))')
  })

  it('operator does not plan a forwarder against an undefined port', () => {
    // Given the LAN edge reconcile
    // When the port is unbound
    // Then the plan branch is guarded out before any listener start: the
    // forwarder has no target to serve and the reconcile only re-syncs the
    // reachable bases
    const edge = bodyOf('applyForwardEdge')
    expect(edge).toContain('Number.isFinite(ctx.webServer.port) ? ctx.webServer.port as number : undefined')
    expect(edge).toContain('if (plan.host === undefined || port === undefined)')
    expect(edge.indexOf('port === undefined')).toBeLessThan(edge.indexOf('forwarder.start('))
  })

  it('operator keeps the LAN base sync behind the same unbound-port guard', () => {
    // Given the reachable-base sync the forwarder lifecycle calls
    // When the port is unbound
    // Then it returns before reading the host, so no :undefined base reaches
    // the QR
    const apply = bodyOf('applyLanBases')
    expect(apply).toContain('if (!Number.isFinite(ctx.webServer.port)) return')
    expect(apply.indexOf('return')).toBeLessThan(apply.indexOf('lanBasesOf('))
  })
})

/**
 * Issues #1893 and #1917: the managed block pinned a literal the webserver
 * schema rejects, and before that it swallowed the row's own bind expression and
 * the CLI flags altogether. Both failure classes came from writing that row, so
 * the invariant is now structural: nothing in this plugin writes a bind, and the
 * one file operation left - removing the legacy block - runs before every other
 * bind step.
 */
describe('the LAN edge never writes a bind (issues #1893 and #1917)', () => {
  it('operator: no code path writes the web server row any more', () => {
    // Given the host half, source and bind planners alike
    // When the bind writers that used to exist are looked for
    // Then none of them is reachable: the flags reach the official row itself
    // and there is nothing left that could replace it
    expect(source).not.toContain('writeLanBind(')
    expect(source).not.toContain('desiredBindHost(')
    expect(source).not.toContain('managedBlock(')
  })

  it('operator: the legacy cleanup runs before the LAN edge and the firewall', () => {
    // Given the deferred bind worker
    // When its steps are read in order
    // Then the block removal comes first: a surviving block keeps replacing the
    // row's config, so the forwarder must not be planned against a profile that
    // still carries one
    const work = bodyOf('applyLanBindWork')
    const cleanup = work.indexOf('cleanupLegacyBlock(')
    const edge = work.indexOf('applyForwardEdge(')
    const firewall = work.indexOf('ensureFirewallRule(')
    expect(cleanup).toBeGreaterThan(-1)
    expect(edge).toBeGreaterThan(cleanup)
    expect(firewall).toBeGreaterThan(edge)
  })

  it('operator: a bind that cannot be taken is reported through the status frame, never thrown', () => {
    // Given the LAN edge reconcile
    // When the forwarder start rejects with a bind error (address gone, port
    // taken)
    // Then the start is observed without throwing, the LAN bases are re-applied
    // from whatever the forwarder reports, and the loopback listener is
    // untouched — the failure reaches the operator on the LAN status frame
    // (`forward.error`), because this plugin keeps the host console clean.
    const edge = bodyOf('applyForwardEdge')
    expect(edge).toContain('forwarder.start(')
    expect(edge).toContain('applyLanBases()')
    expect(edge).not.toContain('throw ')
    expect(edge).not.toContain('console.log')
    expect(edge).not.toContain('console.error')
  })

  it('operator: the CLI --host is honoured by yielding, not by rewriting', () => {
    // Given the LAN edge reconcile
    // When a non-loopback --host already binds the network
    // Then the plan is computed from the startup facts and the master switch
    // (so the yield reason is reachable and a disabled plugin opens nothing),
    // reported on the status frame, and the plugin adds no second listener
    const edge = bodyOf('applyForwardEdge')
    expect(edge).toContain('forwardPlanOf(wanted, startup?.host, liveCapability)')
    expect(edge).toContain('const wanted = value.enabled && value.lanBind')
    expect(edge).toContain('forwardReason = plan.reason')
  })

  it('operator: a machine with no LAN address is reported, not silently skipped', () => {
    // Given the same reconcile
    // When the plan reports no address
    // Then the reason reaches the status frame (the card renders it) and the
    // edge returns without starting a listener
    const edge = bodyOf('applyForwardEdge')
    expect(edge).toContain('forwardReason = plan.reason')
    expect(edge).toContain('plan.host === undefined || port === undefined')
    expect(edge).not.toContain('console.log')
    expect(edge).not.toContain('console.error')
  })
})
