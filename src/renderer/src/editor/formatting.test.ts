import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle, FontFamily } from '@tiptap/extension-text-style'
import { EditorState } from '@tiptap/pm/state'
import { AiChange } from './aiChange'
import { checkUndo, contentJson, fromTagged, replaceFromTagged, replaceKeepingStyle, restoreOriginal, textOf, toTagged } from './changes'
import { diffText, tokenize } from './diff'

const schema = getSchema([StarterKit, TextStyle, FontFamily, AiChange])

type Run = string | [string, ...string[]] // plain text, or [text, ...marks]
const MARK_JSON: Record<string, object> = {
  b: { type: 'bold' },
  i: { type: 'italic' },
  u: { type: 'underline' },
  kai: { type: 'textStyle', attrs: { fontFamily: 'KaiTi' } }
}

/** One-paragraph editor state from runs like ['plain ', ['bold', 'b'], ' more']; '\n' = hard break. */
function para(...runs: Run[]): EditorState {
  const content: object[] = []
  for (const r of runs) {
    const [text, ...marks] = typeof r === 'string' ? [r] : r
    text.split('\n').forEach((part, i) => {
      if (i > 0) content.push({ type: 'hardBreak' })
      if (part) content.push({ type: 'text', text: part, marks: marks.map((m) => MARK_JSON[m]) })
    })
  }
  const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content }] })
  return EditorState.create({ doc, schema })
}

/** Rewrites the whole paragraph to `text`, as "Rewrite doc" does. */
function rewrite(state: EditorState, text: string, id = 'c1'): EditorState {
  const p = state.doc.firstChild!
  return state.apply(replaceKeepingStyle(state.tr, 1, 1 + p.content.size, text, id))
}

/** Formatting of each word as "word:marks" (marks sorted, aiChange left out). */
function styles(state: EditorState): string[] {
  const out: string[] = []
  state.doc.descendants((node) => {
    if (node.type.name === 'hardBreak') out.push('<br>')
    if (!node.isText) return
    const marks = node.marks
      .filter((m) => m.type.name !== 'aiChange')
      .map((m) => (m.type.name === 'textStyle' ? `font=${m.attrs.fontFamily}` : m.type.name))
      .sort()
      .join('+')
    for (const w of node.text!.split(/(\s+)/)) if (w.trim()) out.push(marks ? `${w}:${marks}` : w)
  })
  return out
}

describe('diff', () => {
  it('splits English into words and Chinese into characters', () => {
    expect(tokenize("She doesn't go.")).toEqual(['She', ' ', "doesn't", ' ', 'go', '.'])
    expect(tokenize('我爱中文 OK')).toEqual(['我', '爱', '中', '文', ' ', 'OK'])
  })

  it('finds what stayed, what was removed and what was added', () => {
    const ops = diffText('a big house', 'a large house').map((o) => o.type)
    expect(ops).toEqual(['equal', 'delete', 'insert', 'equal'])
  })
})

describe('keeping formatting through AI changes', () => {
  it('keeps the formatting of words that are unchanged in a rewrite', () => {
    const s = rewrite(para('I love ', ['fresh', 'b'], ' apples and ', ['sweet', 'i'], ' pears.'), 'I really love fresh apples and sweet oranges.')
    expect(textOf(s.doc, 0, s.doc.content.size)).toBe('I really love fresh apples and sweet oranges.')
    expect(styles(s)).toEqual(['I', 'really', 'love', 'fresh:bold', 'apples', 'and', 'sweet:italic', 'oranges.'])
  })

  it('gives a reworded word the formatting of the word it replaces', () => {
    const s = rewrite(para('a ', ['big', 'b', 'u'], ' house'), 'a large house')
    expect(styles(s)).toEqual(['a', 'large:bold+underline', 'house'])
  })

  it('keeps fonts on Chinese text', () => {
    const s = rewrite(para('我很喜欢', ['中文', 'kai'], '写作。'), '我非常喜欢中文写作。')
    expect(styles(s)).toEqual(['我非常喜欢', '中文:font=KaiTi', '写作。'])
  })

  it('does not spread formatting onto words inserted next to it', () => {
    const s = rewrite(para(['Hello', 'b'], ' world'), 'Hello big world')
    expect(styles(s)).toEqual(['Hello:bold', 'big', 'world'])
  })

  it('keeps line breaks and the text after them', () => {
    const s = rewrite(para('Line ', ['one', 'i'], '\nline two'), 'Line one\nline 2')
    expect(styles(s)).toEqual(['Line', 'one:italic', '<br>', 'line', '2'])
  })

  it('formats a fixed word inside a bold sentence as bold (Improve / suggestion)', () => {
    let s = para(['He go to school.', 'b'])
    const from = 1
    s = s.apply(replaceKeepingStyle(s.tr, from, from + 'He go'.length, 'He goes', 's1'))
    expect(styles(s)).toEqual(['He:bold', 'goes:bold', 'to:bold', 'school.:bold'])
  })

  it('undo restores the exact original formatting', () => {
    const original = para('I love ', ['fresh', 'b'], ' and ', ['sweet', 'i', 'kai'], ' pears.')
    const p = original.doc.firstChild!
    const saved = contentJson(original.doc, 1, 1 + p.content.size)
    const changed = rewrite(original, 'I adore crisp and juicy pears.', 'x')
    const check = checkUndo(changed.doc, 'x', 'I adore crisp and juicy pears.')
    expect(check.modified).toBe(false)
    const restored = changed.apply(restoreOriginal(changed.tr, check.range!.from, check.range!.to, 'I love fresh and sweet pears.', saved))
    expect(restored.doc.toJSON()).toEqual(original.doc.toJSON())
  })
})

/** Applies a model's tagged answer to the whole paragraph, as Rewrite doc does. */
function applyTagged(state: EditorState, answer: (tagged: string) => string): EditorState {
  const p = state.doc.firstChild!
  const info = toTagged(state.doc, 1, 1 + p.content.size)
  return state.apply(replaceFromTagged(state.tr, 1, 1 + p.content.size, answer(info.text), info, 'c1'))
}

describe('formatting carried through translation and free rewriting (tags)', () => {
  it('tags differently formatted words, numbering each kind of formatting once', () => {
    const s = para('I love ', ['fresh', 'b'], ' and ', ['sweet', 'i'], ' and ', ['crisp', 'b'], ' apples.')
    expect(toTagged(s.doc, 1, 1 + s.doc.firstChild!.content.size).text).toBe(
      'I love <f1>fresh</f1> and <f2>sweet</f2> and <f1>crisp</f1> apples.'
    )
  })

  it('keeps bold and fonts on the translated words', () => {
    const s = applyTagged(para('I love ', ['fresh', 'b'], ' apples and ', ['tea', 'kai']), (t) => {
      expect(t).toBe('I love <f1>fresh</f1> apples and <f2>tea</f2>')
      return '我喜歡<f1>新鮮的</f1>蘋果和<f2>茶</f2>'
    })
    expect(styles(s)).toEqual(['我喜歡', '新鮮的:bold', '蘋果和', '茶:font=KaiTi'])
  })

  it('applies formatting shared by the whole paragraph to all the new text', () => {
    const s = applyTagged(para(['Hello world', 'kai']), (t) => {
      expect(t).toBe('Hello world') // nothing to tag: the whole paragraph has the same font
      return '你好，世界'
    })
    expect(styles(s)).toEqual(['你好，世界:font=KaiTi'])
  })

  it('handles words moved to a different place by the rewrite', () => {
    const s = applyTagged(para(['Quietly', 'i'], ' the ', ['storm', 'b'], ' passed.'), () => 'The <f2>tempest</f2> passed, <f1>softly</f1>.')
    expect(styles(s)).toEqual(['The', 'tempest:bold', 'passed,', 'softly:italic', '.'])
  })

  it('falls back to word matching when the model breaks or drops the tags', () => {
    const base = para('a ', ['big', 'b'], ' house')
    // Broken tags (unknown number / unclosed): word matching still keeps "house" and the bold reworded word.
    const broken = applyTagged(base, () => 'a <f9>large</f9> house')
    expect(styles(broken)).toEqual(['a', 'large:bold', 'house'])
    const unclosed = applyTagged(base, () => 'a <f1>large house')
    expect(styles(unclosed)).toEqual(['a', 'large:bold', 'house'])
    // All tags dropped: same fallback.
    const dropped = applyTagged(base, () => 'a large house')
    expect(styles(dropped)).toEqual(['a', 'large:bold', 'house'])
  })

  it('rejects crossed tags', () => {
    const s = para(['x', 'b'], ' ', ['y', 'i'])
    const info = toTagged(s.doc, 1, 1 + s.doc.firstChild!.content.size)
    expect(fromTagged('<f1>a<f2>b</f1>c</f2>', info)).toBeNull()
    expect(fromTagged('<f1>a<f2>b</f2></f1>', info)?.text).toBe('ab')
  })
})
