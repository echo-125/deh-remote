/**
 * The remote-control settings card: pairing security and device limits.
 * Registers into the `web-ui.plugin.item` child slot the Web UI plugin group
 * renders, bound to the `remote-web-ui` profile entry's configuration form.
 */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { PluginSettingsCard, ValueField, BooleanField } from './PluginSettingsCard.tsx'
import { PhoneIcon } from './PhoneIcon.tsx'
import { CardForm, booleanField, numberField, textField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'
import { isLanHost, LanBindStatusError, readLanBindStatus, shouldStopLanBindPoll, type LanBindFrame } from './pair-api.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** The remote-control fields this card edits (the namespace's full schema). */
export interface RemoteSettings {
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Token lifetime in ms; the QR link dies after this. */
  tokenTtlMs?: number
  /** A device is "online" while its lastSeenAt is newer than this (ms). */
  offlineAfterMs?: number
  /** Hard cap on paired device sessions (oldest evicted when full). */
  maxDevices?: number
  /** Idle sessions older than this (ms) are deleted. */
  idleExpireMs?: number
  /** Cookie name carrying the paired device id. */
  cookieName?: string
  /** Fence flag: whether non-loopback /api requests must carry a live paired-device cookie. */
  requirePairingForLan?: boolean
  /**
   * LAN bind toggle: once flipped, the plugin starts its runtime LAN forwarder
   * (a LAN literal of this machine) and the matching host firewall rule.
   */
  lanBind?: boolean
  /**
   * Channel diagnostics: the host-side trace, the server-rendered diagnosis
   * page and the browser probes. Off by default - they exist to explain a
   * failing connection, and a working one needs none of them.
   */
  diagnostics?: boolean
}

/** What the remote-control card renders. */
export interface RemoteSettingsCardState extends CardShell {
  /** Master switch. */
  enabled: CardFieldState
  /** Token lifetime. */
  tokenTtlMs: CardFieldState
  /** Device offline threshold. */
  offlineAfterMs: CardFieldState
  /** Paired-device cap. */
  maxDevices: CardFieldState
  /** Idle-expiry window. */
  idleExpireMs: CardFieldState
  /** Device cookie name. */
  cookieName: CardFieldState
  /** LAN fence flag. */
  requirePairingForLan: CardFieldState
  /** LAN bind toggle. */
  lanBind: CardFieldState
  /** Channel diagnostics toggle. */
  diagnostics: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface RemoteSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useRemoteSettingsCard. */
    remoteSettingsCard: SnapshotStore<RemoteSettingsCardState>
  }
}

/** Bridges the `remote-web-ui` form onto the card's staged form. */
export class RemoteSettingsCardController {
  private readonly form: CardForm<RemoteSettings>
  private readonly store: SnapshotStore<RemoteSettingsCardState>

  /** @param scope - the configuration form for the `remote-web-ui` entry. */
  constructor(scope: ConfigForm<RemoteSettings>) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      numberField('tokenTtlMs'),
      numberField('offlineAfterMs'),
      numberField('maxDevices'),
      numberField('idleExpireMs'),
      textField('cookieName'),
      booleanField('requirePairingForLan'),
      booleanField('lanBind'),
      booleanField('diagnostics'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): RemoteSettingsCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      tokenTtlMs: this.form.field('tokenTtlMs'),
      offlineAfterMs: this.form.field('offlineAfterMs'),
      maxDevices: this.form.field('maxDevices'),
      idleExpireMs: this.form.field('idleExpireMs'),
      cookieName: this.form.field('cookieName'),
      requirePairingForLan: this.form.field('requirePairingForLan'),
      lanBind: this.form.field('lanBind'),
      diagnostics: this.form.field('diagnostics'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): RemoteSettingsCardFace {
    return { hooks: { remoteSettingsCard: this.store }, ...this.form.actions() }
  }

  /**
   * Release the card's form subscription and bound stores; the slot
   * disposer calls this on teardown.
   */
  dispose(): void {
    this.form.dispose()
  }
}

/** Props the renderer binds for the remote-control card. */
export type RemoteSettingsCardProps =
  PropsRuntime<'web-ui.plugin.item'>
  & PropsLocale<'remote'>
  & InjectFace<RemoteSettingsCardFace>

/**
 * Render the remote-control card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function RemoteSettingsCard(props: RemoteSettingsCardProps) {
  const { t } = props
  const state = props.useRemoteSettingsCard(snapshot => snapshot)
  const disabled = !state.writable
  /**
   * Whether remote control is currently off. The master switch defaults to
   * OFF, and while it is off the plugin renders no sidebar entry at all — so
   * this card is the ONLY place the feature can be switched on. A collapsed
   * card would leave the operator with a title and no visible control, which
   * reads as "there is no setting for this plugin". Open it whenever the
   * feature is off so the enable switch is the first thing on screen.
   */
  const switchedOff = state.enabled.text.trim() !== 'on'
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey="settings.title"
      descriptionKey="settings.description"
      icon={<PhoneIcon size={18} />}
      defaultOpen={switchedOff}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <BooleanField
        id="settings-remote-enabled"
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <ValueField
        id="settings-remote-token-ttl"
        label={t('settings.tokenTtlMs')}
        hint={t('settings.tokenTtlMsHint')}
        numeric
        {...fieldProps}
        {...state.tokenTtlMs}
        onEdit={(text) => { props.edit('tokenTtlMs', text) }}
        onReset={() => { props.resetField('tokenTtlMs') }}
      />
      <ValueField
        id="settings-remote-offline"
        label={t('settings.offlineAfterMs')}
        hint={t('settings.offlineAfterMsHint')}
        numeric
        {...fieldProps}
        {...state.offlineAfterMs}
        onEdit={(text) => { props.edit('offlineAfterMs', text) }}
        onReset={() => { props.resetField('offlineAfterMs') }}
      />
      <ValueField
        id="settings-remote-max-devices"
        label={t('settings.maxDevices')}
        hint={t('settings.maxDevicesHint')}
        numeric
        {...fieldProps}
        {...state.maxDevices}
        onEdit={(text) => { props.edit('maxDevices', text) }}
        onReset={() => { props.resetField('maxDevices') }}
      />
      <ValueField
        id="settings-remote-idle-expire"
        label={t('settings.idleExpireMs')}
        hint={t('settings.idleExpireMsHint')}
        numeric
        {...fieldProps}
        {...state.idleExpireMs}
        onEdit={(text) => { props.edit('idleExpireMs', text) }}
        onReset={() => { props.resetField('idleExpireMs') }}
      />
      <ValueField
        id="settings-remote-cookie"
        label={t('settings.cookieName')}
        hint={t('settings.cookieNameHint')}
        {...fieldProps}
        {...state.cookieName}
        onEdit={(text) => { props.edit('cookieName', text) }}
        onReset={() => { props.resetField('cookieName') }}
      />
      <BooleanField
        id="settings-remote-fence"
        label={t('settings.requirePairingForLan')}
        hint={t('settings.requirePairingForLanHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.requirePairingForLan}
        onEdit={(text) => { props.edit('requirePairingForLan', text) }}
        onReset={() => { props.resetField('requirePairingForLan') }}
      />
      <LanBindStatus t={t} />
      <BooleanField
        id="settings-remote-lan-bind"
        label={t('settings.lanBind')}
        hint={t('settings.lanBindHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.lanBind}
        onEdit={(text) => { props.edit('lanBind', text) }}
        onReset={() => { props.resetField('lanBind') }}
      />
      <BooleanField
        id="settings-remote-diagnostics"
        label={t('settings.diagnostics')}
        hint={t('settings.diagnosticsHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.diagnostics}
        onEdit={(text) => { props.edit('diagnostics', text) }}
        onReset={() => { props.resetField('diagnostics') }}
      />
    </PluginSettingsCard>
  )
}

/**
 * Live LAN facts above the toggle: the address LAN clients dial, the host
 * process's own listener beside it, the firewall summary, and the reachable LAN
 * URLs. Polls the loopback-only status endpoint; a failure (non-loopback
 * origin) renders nothing — the pairing panel carries the loopback banner
 * instead.
 *
 * Issue #1917 deleted the managed profile block: a runtime forwarder now holds
 * the LAN edge, so the card reports that edge instead of a written block — the
 * address it listens on, why it does not listen (the operator's --host takes the
 * port, or this machine has no LAN address), the bind failure verbatim, and
 * whether the block an older version wrote was cleaned up. The host process's
 * own listener stays visible, so "the LAN entry is a forwarder" is readable
 * rather than inferred. A pre-#1917 host half sends no `forward` field and the
 * frame is read defensively.
 */
export function LanBindStatus({ t }: { t: TranslateNS<'remote'> }) {
  const [frame, setFrame] = useState<LanBindFrame | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void readLanBindStatus().then((value) => {
        if (alive) setFrame(value)
      }).catch((error: unknown) => {
        // The endpoint is loopback-only: a 401/403 means this origin (a paired
        // phone) can never read it, so the 10s poll stops instead of retrying a
        // known refusal for as long as the card stays expanded.
        if (error instanceof LanBindStatusError && shouldStopLanBindPoll(error.status)) window.clearInterval(timer)
      })
    }
    const timer = window.setInterval(read, 10_000)
    read()
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])
  if (frame === undefined) return null
  const forward = frame.forward
  // A listening forwarder IS the edge LAN clients dial, so its address is what
  // the card reports; without one the running bind is the reachable address.
  const entryHost = forward?.listening === true && typeof forward.host === 'string'
    ? forward.host
    : frame.bindHost
  const port = String(frame.port ?? '')
  const localHost = typeof frame.localBindHost === 'string' && frame.localBindHost !== ''
    ? frame.localBindHost
    : undefined
  const firewallText = frame.firewall.managed
    ? t(frame.firewall.ok ? 'lan.firewall.ok' : 'lan.firewall.bad')
    : t('lan.firewall.unmanaged')
  const lines: string[] = [
    t('lan.entry', { host: entryHost ?? '', port }) + ' · ' + firewallText,
  ]
  if (isLanHost(entryHost) && frame.lanUrls.length > 0) {
    lines.push(t('lan.urls', { urls: frame.lanUrls.join('  ') }))
  }
  if (!isLanHost(entryHost)) {
    lines.push(t('lan.off'))
  }
  // The host process's own listener, whenever the LAN edge sits beside it: a
  // phone reading "LAN entry: 192.168.1.5:3080" still needs to know the process
  // itself answers on loopback.
  if (localHost !== undefined && localHost !== entryHost) {
    lines.push(t('lan.localBind', { host: localHost, port }))
  }
  if (forward !== undefined && !forward.listening) {
    // A bind failure is reported verbatim and first: it is the concrete reason
    // the LAN entry is missing, and the loopback entry still works.
    if (typeof forward.error === 'string' && forward.error !== '') {
      lines.push(t('lan.forward.error', { error: forward.error }))
    } else if (forward.reason === 'host-bind') {
      lines.push(t('lan.forward.yield', { host: localHost ?? entryHost ?? '' }))
    }
  }
  if (frame.lanBlocked === true || forward?.reason === 'no-address') {
    lines.push(t('lan.noLanAddress'))
  }
  if (frame.setting === null) {
    lines.push(t('lan.untouched'))
  }
  if (frame.pendingRestart === true) {
    lines.push(t('lan.pendingRestart'))
  }
  if (frame.legacyBlockRemoved === true) {
    lines.push(t('lan.legacyRemoved'))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, lineHeight: '18px', opacity: 0.85 }}>
      {lines.map((line, index) => (
        <div key={index} style={{ wordBreak: 'break-all' }}>{line}</div>
      ))}
    </div>
  )
}
