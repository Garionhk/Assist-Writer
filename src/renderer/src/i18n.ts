// Interface language: English or Traditional Chinese. Text is written in English in the code,
// `t('Save')`, and looked up in the Traditional Chinese table below; `{name}` placeholders are
// filled from `vars`. The choice is a setting (shared by every window) and is also remembered
// in this browser so the first screen (and the web login) already uses it.
import { ZH_HANT } from './i18n.zh-Hant'

export type Lang = 'en' | 'zh-Hant'

const KEY = 'assistWriter.uiLanguage'

function saved(): Lang {
  try {
    return localStorage.getItem(KEY) === 'zh-Hant' ? 'zh-Hant' : 'en'
  } catch {
    return 'en'
  }
}

let current: Lang = typeof localStorage === 'undefined' ? 'en' : saved()
const listeners = new Set<(lang: Lang) => void>()

export function getLanguage(): Lang {
  return current
}

/** Switches the language (no-op if unchanged) and tells listeners such as image toolbars. */
export function setLanguage(lang: Lang) {
  if (lang !== 'zh-Hant') lang = 'en'
  if (lang === current) return
  current = lang
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    // Storage unavailable: the setting still applies through the app settings.
  }
  document.documentElement.lang = lang === 'zh-Hant' ? 'zh-Hant' : 'en'
  listeners.forEach((cb) => cb(lang))
}

export function onLanguageChange(cb: (lang: Lang) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The text in the current language. */
export function t(en: string, vars?: Record<string, string | number>): string {
  const text = current === 'zh-Hant' ? (ZH_HANT[en] ?? en) : en
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text
}

/** `one` when n is 1, else `many` (English plurals; Chinese uses the same text for both). */
export function tn(n: number, one: string, many: string, vars?: Record<string, string | number>): string {
  return t(n === 1 ? one : many, { n, ...vars })
}
