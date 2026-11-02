import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import { EditorState } from '@tiptap/pm/state'
import { AiChange } from './aiChange'
import { changeIdsInDoc, checkUndo, findChangeRange, replaceKeepingStyle, textOf } from './changes'
import { locateSuggestions } from './suggestions'

const schema = getSchema([StarterKit, TextStyle, AiChange])

function stateFrom(paragraphs: string[]): EditorState {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: paragraphs.map((t) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] }))
  })
  return EditorState.create({ doc, schema })
}

/** Position of `needle` in the doc text (first match). */
function find(state: EditorState, needle: string): { from: number; to: number } {
  let result: { from: number; to: number } | null = null
  state.doc.descendants((node, pos) => {
    if (result || !node.isText) return
    const i = node.text!.indexOf(needle)
    if (i >= 0) result = { from: pos + i, to: pos + i + needle.length }
  })
  if (!result) throw new Error(`not found: ${needle}`)
  return result
}

describe('locateSuggestions', () => {
  it('positions suggestions inside the paragraph and drops bad ones', () => {
    const text = 'He go to school. He go home.'
    const found = locateSuggestions(
      text,
      10,
      [
        { original: 'He go', suggestion: 'He goes', reason: '', type: 'grammar' },
        { original: 'He go', suggestion: 'He goes', reason: '', type: 'grammar' },
        { original: 'missing', suggestion: 'x', reason: '', type: 'style' },
        { original: 'school', suggestion: 'school', reason: '', type: 'style' },
        { original: 'home', suggestion: 'house', reason: '', type: 'style' }
      ],
      new Set(['home'])
    )
    // Two "He go" occurrences get separate, non-overlapping positions.
    expect(found.map((f) => [f.from, f.to])).toEqual([
      [10, 15],
      [27, 32]
    ])
  })

  it('works with Chinese text', () => {
    const found = locateSuggestions('我很高兴的说', 1, [
      { original: '高兴的说', suggestion: '高兴地说', reason: '状语用“地”', type: 'grammar' }
    ])
    expect(found[0]).toMatchObject({ from: 3, to: 7, type: 'grammar' })
  })
})

describe('AI change tracking and selective undo', () => {
  it('tags a replacement and finds it after edits elsewhere', () => {
    let state = stateFrom(['He go to school every days.'])
    const r = find(state, 'every days')
    state = state.apply(replaceKeepingStyle(state.tr, r.from, r.to, 'every day', 'c1'))
    expect(state.doc.textContent).toBe('He go to school every day.')
    expect(changeIdsInDoc(state.doc)).toEqual(new Set(['c1']))

    // Type text before the change: the mark moves with its text.
    state = state.apply(state.tr.insertText('Today ', 1))
    const range = findChangeRange(state.doc, 'c1')!
    expect(textOf(state.doc, range.from, range.to)).toBe('every day')
  })

  it('undoes only the chosen change among several', () => {
    let state = stateFrom(['one two three'])
    for (const [word, repl, id] of [
      ['one', 'ONE', 'a'],
      ['two', 'TWO', 'b'],
      ['three', 'THREE', 'c']
    ]) {
      const r = find(state, word)
      state = state.apply(replaceKeepingStyle(state.tr, r.from, r.to, repl, id))
    }
    expect(state.doc.textContent).toBe('ONE TWO THREE')

    const check = checkUndo(state.doc, 'b', 'TWO')
    expect(check.modified).toBe(false)
    state = state.apply(replaceKeepingStyle(state.tr, check.range!.from, check.range!.to, 'two', null))
    expect(state.doc.textContent).toBe('ONE two THREE')
    expect(changeIdsInDoc(state.doc)).toEqual(new Set(['a', 'c']))
  })

  it('reports when the changed text was edited afterwards', () => {
    let state = stateFrom(['I am happy.'])
    const r = find(state, 'happy')
    state = state.apply(replaceKeepingStyle(state.tr, r.from, r.to, 'delighted', 'x'))
    // Edit inside the changed text: typed characters inherit the mark.
    const d = find(state, 'delighted')
    state = state.apply(state.tr.insertText('very ', d.from + 0).delete(d.from + 5 + 6, d.from + 5 + 9))
    const check = checkUndo(state.doc, 'x', 'delighted')
    expect(check.range).not.toBeNull()
    expect(check.modified).toBe(true)
  })

  it('keeps the formatting of the replaced text', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bad grammer', marks: [{ type: 'bold' }] }] }]
    })
    let state = EditorState.create({ doc, schema })
    const r = find(state, 'grammer')
    state = state.apply(replaceKeepingStyle(state.tr, r.from, r.to, 'grammar', 'g'))
    const node = state.doc.nodeAt(find(state, 'grammar').from)!
    expect(node.marks.map((m) => m.type.name).sort()).toEqual(['aiChange', 'bold'])
  })

  it('returns no range for a change that was removed', () => {
    const state = stateFrom(['nothing here'])
    expect(checkUndo(state.doc, 'gone', 'x').range).toBeNull()
  })
})
