/**
 * First-level settings section.
 *
 * While the master switch is OFF this plugin renders no sidebar entry at all,
 * and the official plugin-card seat (`plugins.bundle.config`) lives three
 * levels deep — Settings, Plugins, this package's page. An operator who turns
 * remote access off therefore had no discoverable place to turn it back on.
 * This module claims one `settings.section` entry (the Settings panel's own
 * nav list) that renders the SAME card, bound to the SAME settings form, so
 * both surfaces edit one form and the enable switch is always one click from
 * the Settings sidebar.
 *
 * CONTRACT (verified, not guessed):
 *
 * - `settings.section` is a `list` / `root` slot whose entry options carry the
 *   nav identity `id`, `order` and `label` (the shell reads exactly
 *   `e.options.id`, `e.options.order`, `resolveSlotLabel(e.options.label)`;
 *   `dsh-client-ui-settings-general` §"hooks.sections"). There is no icon
 *   option.
 * - The owner share the shell passes is `SettingsSectionOwnerProps` — `close`,
 *   the shell's own panel-closing affordance
 *   (`@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`
 *   lines 73-77 and 154-157; rendered as
 *   `renderSlot('settings.section', { close: onClose }, { only: active })`).
 *   The card ignores it: a settings section has nothing to close for.
 * - The section is rendered ONLY where the shell draws it — the settings modal
 *   — never on the plugin manager page, and it is rendered whether or not the
 *   plugin is enabled (the section is not gated on the master switch).
 * - `dshmarket` registers its own section the same way (slot name, `id`,
 *   `order`, `label` thunk, `locale`, `inject`, component).
 *
 * REGISTRATION GOES THROUGH `slots.inject`, the declaration-lifetime seam:
 * `slots.register` throws when the slot is not declared yet, and the section
 * slot is declared by the settings shell's own registration in
 * `dsh-client-ui-settings-general`, whose boot order relative to an external
 * plugin's `apply()` is not guaranteed. The shared helper
 * (`shared/client/settings/plugin-card-seat.ts`) documents the same reason.
 * A host that never declares the seat (a deployment without the settings
 * shell's section list) keeps today's behaviour: the callback never runs.
 */

import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The first-level settings section the card is also reachable from. */
export const SETTINGS_SECTION_SLOT = 'settings.section'

/** Nav entry id of this plugin's settings section (its key in the nav list). */
export const SETTINGS_SECTION_ID = 'deh-remote'

/**
 * Nav position. The official sections sort `general` at 0, the family group at
 * 110 and the market at 150; 120 keeps remote access in the third-party run
 * beside the family group, well above the store.
 */
export const SETTINGS_SECTION_ORDER = 120

/** Owner props the settings shell passes to a section (declared shape). */
export type { SettingsSectionOwnerProps }

/**
 * The locale namespace this package registers its dictionaries under (the
 * registration options' `locale` field, which also gives the card its `t`).
 */
export type SettingsSectionContext = {
  slots: {
    /**
     * Registration inside a slot's declaration lifetime (structurally
     * satisfied by `ctx.slots.inject`).
     */
    inject(key: string, callback: () => unknown): unknown
    /** One section contribution; returns its disposer. */
    register(options: never, component: never): unknown
  }
  /** Locale service: `bind(ns)` yields the translate seat used for the nav label. */
  locale: {
    bind(namespace: string): (key: never) => string
  }
}

/**
 * The register options this module passes. Spelled out so the contract is
 * readable (and testable) in one place rather than buried in a call.
 * @param locale - the dictionary namespace of this package.
 * @param label - the nav label thunk (re-read by the shell on every ledger bump).
 * @returns the entry options for `settings.section`.
 */
export function sectionEntryOptions<S extends object>(
  locale: string,
  label: () => string,
  inject: () => S,
): {
  name: string
  id: string
  order: number
  label: () => string
  locale: string
  inject: () => S
} {
  return {
    name: SETTINGS_SECTION_SLOT,
    id: SETTINGS_SECTION_ID,
    order: SETTINGS_SECTION_ORDER,
    label,
    locale,
    inject,
  }
}

/**
 * Register the remote-access settings section.
 *
 * @param ctx - client context (its slot registry and locale service).
 * @param options - the card component and the business face its registration
 *   injects (the same face the plugin-card seat passes).
 * @returns nothing; the entry lives as long as the slot declaration does.
 */
export function installSettingsSection<S extends object>(
  ctx: SettingsSectionContext,
  options: {
    /** Dictionary namespace (also the nav label's namespace). */
    locale: string
    /** Nav label thunk; defaults to `settings.sectionLabel` in `locale`. */
    label?: () => string
    /** Business-face factory of the registration. */
    inject: () => S
    /**
     * The card component (the same one the plugin-card seat renders). Taken
     * erased: its props type is the composed seat shape, chosen at runtime, so
     * the registrant keeps its precise typing at the call site — the same
     * erasure the shared plugin-card helper applies to the same component.
     */
    component: unknown
  },
): void {
  try {
    const label = options.label
      ?? (() => (ctx.locale.bind(options.locale)('settings.sectionLabel' as never) as string))
    ctx.slots.inject(SETTINGS_SECTION_SLOT, () => {
      try {
        return ctx.slots.register(
          sectionEntryOptions(options.locale, label, options.inject) as never,
          options.component as never,
        ) as () => void
      } catch {
        // A seat that refuses the entry (a foreign section already holds the
        // id) leaves the official plugin-card seat as the settings surface.
        return () => {}
      }
    })
  } catch {
    // A host without the section seat at all: the plugin keeps its official
    // bundle-configuration card and this module is a no-op.
  }
}
