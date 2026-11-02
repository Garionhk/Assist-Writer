import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { getLanguage, t, tn } from './i18n'
import { ZH_HANT } from './i18n.zh-Hant'

/** Every English text the interface shows: t(…) / tn(…) calls, and the image toolbar's labels. */
function interfaceTexts(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(f) && !/\.test\.|i18n/.test(f)) files.push(p)
    }
  }
  walk(path.join(__dirname))
  const lit = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`
  const value = (s: string) => JSON.parse(s[0] === "'" ? `"${s.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : s) as string
  const out = new Set<string>()
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const patterns = [String.raw`\bt\(\s*` + lit, String.raw`\btn\([^,]+,\s*` + lit + String.raw`\s*,\s*` + lit]
    if (f.endsWith('image.ts')) {
      patterns.push(String.raw`add\(row\d, ` + lit + ', ' + lit, String.raw`field\('\w+', ` + lit + ', ' + lit)
      patterns.push(String.raw`(?:label|title): ` + lit, String.raw`dataset\.(?:label|title) = ` + lit)
    }
    for (const p of patterns) for (const m of src.matchAll(new RegExp(p, 'g'))) for (const g of m.slice(1)) if (g) out.add(value(g))
  }
  return [...out]
}

/** Arrows, the lock and X / Y stay as they are in both languages. */
const SAME_IN_BOTH = new Set(['⇤', '↔', '⇥', '🔒', 'X', 'Y'])

describe('interface language', () => {
  it('has Traditional Chinese for every interface text, with the same placeholders', () => {
    const texts = interfaceTexts()
    expect(texts.length).toBeGreaterThan(200)
    const missing = texts.filter((s) => !SAME_IN_BOTH.has(s) && !(s in ZH_HANT))
    expect(missing).toEqual([])
    for (const [en, zh] of Object.entries(ZH_HANT)) {
      const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(holes(zh), en).toEqual(holes(en))
    }
  })

  it('uses Traditional, not Simplified, characters', () => {
    const SIMPLIFIED = /[学级语词简关联动杂适辞结构确运论证严练笔优变书谨无术统逻辑观洁该领资专业务礼说写细腻画陈滥调饰应们这时为国对会发经过还进现开问长从实点么样头见题车认识间让请传设记录删档图选择显载链码钮键户单页缩换启储复编辑]/
    for (const zh of Object.values(ZH_HANT)) expect(zh.match(SIMPLIFIED)?.[0] ?? null, zh).toBeNull()
  })

  it('fills placeholders and English plurals', () => {
    expect(getLanguage()).toBe('en')
    expect(t('Exported to {path}', { path: 'a.pdf' })).toBe('Exported to a.pdf')
    expect(tn(1, '1 word', '{n} words')).toBe('1 word')
    expect(tn(3, '1 word', '{n} words')).toBe('3 words')
  })
})
