import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { textOf } from './changes'

export type SuggestionType = 'grammar' | 'style'

export interface RawSuggestion {
  original: string
  suggestion: string
  reason: string
  type: SuggestionType
}

export interface Suggestion extends RawSuggestion {
  id: string
  from: number
  to: number
}

interface PluginState {
  items: Suggestion[]
  activeId: string | null
  deco: DecorationSet
}

export interface SuggestionMeta {
  /** Remove suggestions that lie inside this range (before adding new ones for it). */
  clearRange?: { from: number; to: number }
  add?: Suggestion[]
  removeIds?: string[]
  clearAll?: boolean
  /** Highlight one suggestion (the one whose popup is open); null clears. */
  active?: string | null
}

export const suggestionKey = new PluginKey<PluginState>('suggestions')

let nextId = 1

/**
 * Finds where each model suggestion's `original` text sits inside a paragraph and turns it
 * into a positioned Suggestion. Unfound, no-op, ignored and overlapping items are dropped.
 */
export function locateSuggestions(
  paragraphText: string,
  paragraphStart: number,
  raw: RawSuggestion[],
  ignored: Set<string> = new Set()
): Suggestion[] {
  const found: Suggestion[] = []
  for (const r of raw) {
    if (!r || typeof r.original !== 'string' || typeof r.suggestion !== 'string') continue
    const original = r.original
    if (!original.trim() || original === r.suggestion || ignored.has(original)) continue
    // Prefer an occurrence that doesn't overlap an earlier suggestion.
    let idx = paragraphText.indexOf(original)
    while (idx >= 0 && found.some((f) => overlaps(f, paragraphStart + idx, paragraphStart + idx + original.length))) {
      idx = paragraphText.indexOf(original, idx + 1)
    }
    if (idx < 0) continue
    found.push({
      id: `s${nextId++}`,
      from: paragraphStart + idx,
      to: paragraphStart + idx + original.length,
      original,
      suggestion: r.suggestion,
      reason: r.reason ?? '',
      type: r.type === 'grammar' ? 'grammar' : 'style'
    })
  }
  return found.sort((a, b) => a.from - b.from)
}

function overlaps(s: { from: number; to: number }, from: number, to: number): boolean {
  return from < s.to && to > s.from
}

function buildDeco(state: EditorState, items: Suggestion[], activeId: string | null): DecorationSet {
  return DecorationSet.create(
    state.doc,
    items.map((s) =>
      Decoration.inline(s.from, s.to, {
        class: `sug sug-${s.type}${s.id === activeId ? ' sug-active' : ''}`,
        'data-sug-id': s.id
      })
    )
  )
}

export function getSuggestions(state: EditorState): Suggestion[] {
  return suggestionKey.getState(state)?.items ?? []
}

export function suggestionAt(state: EditorState, pos: number): Suggestion | null {
  return getSuggestions(state).find((s) => pos >= s.from && pos <= s.to) ?? null
}

export interface SuggestionsOptions {
  /** Called when the user clicks a suggestion underline (or clicks elsewhere: null). */
  onActivate: (s: Suggestion | null, view: EditorView) => void
}

export const Suggestions = Extension.create<SuggestionsOptions>({
  name: 'suggestions',

  addOptions() {
    return { onActivate: () => {} }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin<PluginState>({
        key: suggestionKey,
        state: {
          init: (_, state) => ({ items: [], activeId: null, deco: DecorationSet.create(state.doc, []) }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(suggestionKey) as SuggestionMeta | undefined
            let items = value.items
            let activeId = value.activeId
            let changed = false

            if (tr.docChanged) {
              // Follow edits; drop suggestions whose text was changed.
              items = items
                .map((s) => ({ ...s, from: tr.mapping.map(s.from, 1), to: tr.mapping.map(s.to, -1) }))
                .filter((s) => s.from < s.to && textOf(newState.doc, s.from, s.to) === s.original)
              changed = true
            }
            if (meta) {
              if (meta.clearAll) items = []
              if (meta.clearRange) {
                const { from, to } = meta.clearRange
                items = items.filter((s) => s.to <= from || s.from >= to)
              }
              if (meta.removeIds) items = items.filter((s) => !meta.removeIds!.includes(s.id))
              if (meta.add) {
                const add = meta.add.filter((a) => !items.some((s) => overlaps(s, a.from, a.to)))
                items = [...items, ...add].sort((a, b) => a.from - b.from)
              }
              if (meta.active !== undefined) activeId = meta.active
              changed = true
            }
            if (activeId && !items.some((s) => s.id === activeId)) activeId = null
            if (!changed) return value
            return { items, activeId, deco: buildDeco(newState, items, activeId) }
          }
        },
        props: {
          decorations: (state) => suggestionKey.getState(state)?.deco,
          handleClick: (view, pos) => {
            const s = suggestionAt(view.state, pos)
            options.onActivate(s, view)
            return false
          }
        }
      })
    ]
  }
})
