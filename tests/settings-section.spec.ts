/**
 * First-level settings section.
 *
 * The master switch defaults to OFF, and while it is off this plugin renders no
 * sidebar entry. The settings section is what makes the feature discoverable on
 * a disabled install, so these cases pin the three facts that failure depends
 * on: the entry lands on `settings.section` (not the official bundle-config
 * seat), it renders the SAME card with the SAME injected face the plugin card
 * uses, and its nav label comes from the registered dictionary in both locales.
 */
import { describe, expect, it } from 'vitest'
import {
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTION_SLOT,
  installSettingsSection,
  sectionEntryOptions,
  type SettingsSectionContext,
} from '../src/client/settings-section.ts'
import { en, zh } from '../src/client/locales.ts'

/** Owner props the settings shell passes to a section (the declared contract). */
const SHELL_OWNER_PROPS = { close: () => {} }

/** One recorded registration. */
interface Recorded {
  /** Entry options of the registration. */
  options: Record<string, unknown>
  /** The component registered for the entry. */
  component: unknown
}

/**
 * A client context double with a slot registry that models declaration
 * lifetimes: `inject` runs its callback immediately when `declared` is true and
 * parks it until `declare()` otherwise — the boot-order shape of a real host.
 */
function context(options: { declared?: boolean; locale?: 'zh' | 'en'; refuse?: boolean } = {}): {
  ctx: SettingsSectionContext
  registrations: Recorded[]
  /** Declare the slot now, running every parked injection callback. */
  declare: () => void
  /** Whether the section seat was asked about through `slots.inject`. */
  injected: string[]
} {
  const registrations: Recorded[] = []
  const parked: Array<() => unknown> = []
  const injected: string[] = []
  let declared = options.declared === true
  const dictionary = options.locale === 'en' ? en : zh
  const ctx: SettingsSectionContext = {
    slots: {
      inject(key, callback) {
        injected.push(key)
        if (declared) {
          callback()
        } else {
          parked.push(callback)
        }
        return () => {}
      },
      register(entry, component) {
        if (options.refuse === true) throw new Error('slot "settings.section" already has an entry for key "deh-remote"')
        registrations.push({ options: entry as Record<string, unknown>, component })
        return () => {}
      },
    },
    locale: {
      bind: (namespace: string) => {
        expect(namespace).toBe('remote')
        return ((key: string) => {
          const value = (dictionary as Record<string, string>)[key]
          if (value === undefined) throw new Error('missing locale key ' + key)
          return value
        }) as never
      },
    },
  }
  return {
    ctx,
    registrations,
    declare: () => {
      declared = true
      while (parked.length > 0) parked.shift()?.()
    },
    injected,
  }
}

/** The card double the section registers (identity is what these cases assert). */
const Card = (): null => null

/** The controller face double (the same object both surfaces would receive). */
const face = { ready: true }

describe('remote access settings section', () => {
  it('operator gets a first-level settings entry that is not gated on the enable switch', () => {
    // Given a host whose settings shell declares the section seat
    const harness = context({ declared: true })
    // When the plugin installs its section (no enabled-state argument exists)
    installSettingsSection(harness.ctx, { locale: 'remote', inject: () => face, component: Card })
    // Then exactly one entry landed on the settings nav slot
    expect(harness.registrations).toHaveLength(1)
    expect(harness.registrations[0]?.options).toMatchObject({
      name: SETTINGS_SECTION_SLOT,
      id: SETTINGS_SECTION_ID,
      order: SETTINGS_SECTION_ORDER,
      locale: 'remote',
    })
    // And it is the settings section, not the official plugin-card seat
    expect(harness.registrations[0]?.options.name).not.toBe('plugins.bundle.config')
    expect(harness.registrations[0]?.options).not.toHaveProperty('key')
  })

  it('operator sees the same card and the same form face on both settings surfaces', () => {
    // Given the card and the controller face a plugin passes to both surfaces
    const harness = context({ declared: true })
    // When the section is installed with the plugin's own card and face factory
    installSettingsSection(harness.ctx, { locale: 'remote', inject: () => face, component: Card })
    const entry = harness.registrations[0]
    // Then the section registers that exact component
    expect(entry?.component).toBe(Card)
    // And its injected face is the controller's own face object
    const injected = (entry?.options.inject as () => unknown)()
    expect(injected).toBe(face)
  })

  it('operator gets the section even when the settings shell declares it after the plugin applied', () => {
    // Given a host whose shell has not declared the section seat yet
    const harness = context()
    // When the plugin applies first
    installSettingsSection(harness.ctx, { locale: 'remote', inject: () => face, component: Card })
    // Then nothing is registered against an undeclared slot and the wait is parked
    expect(harness.injected).toEqual([SETTINGS_SECTION_SLOT])
    expect(harness.registrations).toHaveLength(0)
    // When the shell declares the seat
    harness.declare()
    // Then the section registers through the declaration lifetime
    expect(harness.registrations).toHaveLength(1)
  })

  it('operator gets a degraded surface instead of a crash on a host without the seat', () => {
    // Given a host with no settings-section seat at all
    const broken = {
      slots: {
        inject: () => { throw new Error('slot "settings.section" is not declared') },
        register: () => { throw new Error('unreachable') },
      },
      locale: { bind: () => () => 'Remote access' },
    } as unknown as SettingsSectionContext
    // When the section is installed
    // Then nothing throws: the official plugin-card seat stays the settings surface
    expect(() => { installSettingsSection(broken, { locale: 'remote', inject: () => face, component: Card }) }).not.toThrow()

    // Given a declared seat that refuses this entry
    const refusing = context({ declared: true, refuse: true })
    // When the section is installed
    // Then the refusal is contained
    expect(() => { installSettingsSection(refusing.ctx, { locale: 'remote', inject: () => face, component: Card }) }).not.toThrow()
    expect(refusing.registrations).toHaveLength(0)
  })

  it('operator reads the nav label as "远程访问" in Chinese and "Remote access" in English', () => {
    // Given the section installed on a Chinese page and on an English page
    const zhHarness = context({ declared: true, locale: 'zh' })
    const enHarness = context({ declared: true, locale: 'en' })
    // When each reads its nav label thunk
    installSettingsSection(zhHarness.ctx, { locale: 'remote', inject: () => face, component: Card })
    installSettingsSection(enHarness.ctx, { locale: 'remote', inject: () => face, component: Card })
    const zhLabel = (zhHarness.registrations[0]?.options.label as () => string)()
    const enLabel = (enHarness.registrations[0]?.options.label as () => string)()
    // Then each is the section label of its dictionary
    expect(zhLabel).toBe('远程访问')
    expect(enLabel).toBe('Remote access')
    expect(zhLabel).toBe(zh['settings.sectionLabel'])
    expect(enLabel).toBe(en['settings.sectionLabel'])
  })

  it('operator gets a locale-complete section label key', () => {
    // Given the zh dictionary is the key source
    // When the en key set is compared with it
    // Then the section label exists in both, with no CJK left in the English copy
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(zh['settings.sectionLabel']).toBeTruthy()
    expect(en['settings.sectionLabel']).toBe('Remote access')
    expect(en['settings.sectionLabel']).not.toMatch(/[\u4E00-\u9FFF]/)
  })

  it('section entry options stay exactly the nav contract the shell reads', () => {
    // Given the entry options builder
    // When it is called
    const options = sectionEntryOptions('remote', () => 'Remote access', () => face)
    // Then it carries only the projected fields (id / order / label), plus the
    // locale namespace and inject face every list entry may carry
    expect(Object.keys(options).sort()).toEqual(['id', 'inject', 'label', 'locale', 'name', 'order'])
    // And the shell's owner share (`close`) is simply not part of the registration
    expect(options).not.toHaveProperty('close')
    expect(SHELL_OWNER_PROPS.close).toBeTypeOf('function')
  })
})
