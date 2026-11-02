import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLES, findStyle } from '../../../shared/styles'
import { checkMessages, improveMessages, rewriteMessages, styleBlock } from './prompts'

describe('writing styles', () => {
  it('ships ten built-in styles with unique ids and prompts', () => {
    expect(DEFAULT_STYLES).toHaveLength(10)
    expect(new Set(DEFAULT_STYLES.map((s) => s.id)).size).toBe(10)
    for (const s of DEFAULT_STYLES) expect(s.prompt.length).toBeGreaterThan(80)
  })

  it('finds a style by id, or null', () => {
    expect(findStyle(DEFAULT_STYLES, 'lawyer')?.name).toBe('Professional lawyer')
    expect(findStyle(DEFAULT_STYLES, 'missing')).toBeNull()
    expect(findStyle(DEFAULT_STYLES, null)).toBeNull()
  })

  it('adds the style to every prompt only when one is selected', () => {
    const style = findStyle(DEFAULT_STYLES, 'grade-3-5')!
    expect(styleBlock(null)).toBe('')
    const ctx = { summary: '', before: '', after: '' }
    expect(checkMessages('Text.', ctx)[0].content).not.toContain('TARGET WRITING STYLE')
    expect(checkMessages('Text.', ctx, style)[0].content).toContain('TARGET WRITING STYLE: Elementary (Grade 3–5)')
    expect(improveMessages('Text.', { summary: '', paragraph: '' }, style)[0].content).toContain(style.prompt)
    expect(rewriteMessages(['Text.'], '', style)[0].content).toContain(style.prompt)
  })

  it('lets Improve/Rewrite follow a translation style, but never live checking', () => {
    const translator = { id: 't', name: 'Translator', prompt: 'Translate into Traditional Chinese.' }
    const ctx = { summary: '', before: '', after: '' }
    expect(checkMessages('Text.', ctx, translator)[0].content).toContain('Never translate')
    expect(improveMessages('Text.', { summary: '', paragraph: '' }, translator)[0].content).toContain('UNLESS the TARGET WRITING STYLE')
    expect(rewriteMessages(['Text.'], '', translator)[0].content).not.toContain('Never translate')
  })

  it('uses Traditional Chinese in every built-in style and instruction', () => {
    // Characters that only exist in Simplified Chinese (their Traditional forms differ).
    const SIMPLIFIED = /[学级语词简关联动杂适辞结构确运论证严练笔优变书谨无术统逻辑观洁该领资专业务礼说写细腻画陈滥调饰应们这时为国对会发经过还进现开问长从实点么样头见题车认识间让请传]/
    const ctx = { summary: '', before: '', after: '' }
    const texts = [
      ...DEFAULT_STYLES.map((s) => s.prompt),
      ...DEFAULT_STYLES.map((s) => checkMessages('x', ctx, s)[0].content),
      improveMessages('<f1>x</f1>', { summary: '', paragraph: '' })[0].content,
      rewriteMessages(['<f1>x</f1>'], '')[0].content
    ]
    for (const t of texts) expect(t.match(SIMPLIFIED)?.[0] ?? null).toBeNull()
    expect(DEFAULT_STYLES[0].prompt).toContain('小學三至五年級')
  })

  it('explains the formatting tags only when there are some', () => {
    expect(rewriteMessages(['Plain.'], '')[0].content).not.toContain('FORMATTING TAGS')
    expect(rewriteMessages(['A <f1>bold</f1> word.'], '')[0].content).toContain('FORMATTING TAGS')
    expect(improveMessages('<f1>x</f1>', { summary: '', paragraph: '' })[0].content).toContain('FORMATTING TAGS')
  })
})
