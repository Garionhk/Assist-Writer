import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Settings } from '../../../shared/types'
import { findStyle } from '../../../shared/styles'
import { textOf, withoutObjects } from '../editor/changes'
import { locateSuggestions, suggestionKey, type RawSuggestion, type SuggestionMeta } from '../editor/suggestions'
import { CHECK_SCHEMA, LIVE_CTX, checkMessages, parseJson, summaryMessages } from './prompts'

export interface TextBlock {
  /** Position of the block node; its text starts at pos + 1. */
  pos: number
  node: PMNode
  text: string
}

/** All non-empty text blocks (paragraphs, headings, list paragraphs), excluding code. */
export function textBlocks(doc: PMNode): TextBlock[] {
  const blocks: TextBlock[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (node.type.name !== 'codeBlock') {
      const text = textOf(node, 0, node.content.size)
      // Paragraphs holding only an image have nothing to check or rewrite.
      if (withoutObjects(text).trim()) blocks.push({ pos, node, text })
    }
    return false
  })
  return blocks
}

export type CheckStatus =
  | { state: 'idle' }
  | { state: 'checking'; remaining: number }
  | { state: 'error'; message: string }

let requestSeq = 0
export const newRequestId = (prefix: string): string => `${prefix}-${Date.now()}-${requestSeq++}`

/**
 * Watches the document and checks changed paragraphs with the live model after a pause in
 * typing. Paragraph texts that were already checked are cached so they aren't re-sent.
 */
export class LiveChecker {
  private timer: ReturnType<typeof setTimeout> | null = null
  private checked = new Set<string>()
  private queue: string[] = []
  private running = false
  private currentRequest: string | null = null
  private summary = ''
  private summaryLength = 0
  private summarizing = false
  private disposed = false

  constructor(
    private editor: Editor,
    private getSettings: () => Settings,
    private getIgnored: () => Set<string>,
    private onStatus: (s: CheckStatus) => void
  ) {}

  /** Call on every document change. */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.getSettings().liveCheck) return
    this.timer = setTimeout(() => this.collect(), this.getSettings().debounceMs)
  }

  /** Re-check every paragraph now. */
  checkAll(): void {
    this.checked.clear()
    this.collect(true)
  }

  /** The writing style changed: drop current suggestions and re-check with the new style. */
  restyle(): void {
    this.queue = []
    if (this.currentRequest) window.api.cancelChat(this.currentRequest)
    this.checked.clear()
    this.editor.view.dispatch(this.editor.state.tr.setMeta(suggestionKey, { clearAll: true } satisfies SuggestionMeta))
    this.schedule()
  }

  /** Forget everything (new document loaded). */
  reset(): void {
    this.checked.clear()
    this.queue = []
    this.summary = ''
    this.summaryLength = 0
    if (this.currentRequest) window.api.cancelChat(this.currentRequest)
    this.editor.view.dispatch(this.editor.state.tr.setMeta(suggestionKey, { clearAll: true } satisfies SuggestionMeta))
  }

  /** Marks a paragraph text as already checked (e.g. right after accepting a suggestion). */
  markChecked(text: string): void {
    this.checked.add(text)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.queue = []
    if (this.currentRequest) window.api.cancelChat(this.currentRequest)
    this.onStatus({ state: 'idle' })
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  get documentSummary(): string {
    return this.summary
  }

  private collect(force = false): void {
    if (this.disposed) return
    if (!force && !this.getSettings().liveCheck) return
    // Don't check half-typed words while a Chinese IME is composing.
    if (this.editor.view.composing) {
      this.schedule()
      return
    }
    const blocks = textBlocks(this.editor.state.doc).filter((b) => b.text.trim().length >= 3 && !this.checked.has(b.text))
    // The paragraph being written is checked first, then the ones nearest to it.
    const pending = orderByCursor(blocks, this.editor.state.selection.from).map((b) => b.text)
    this.queue = [...new Set(pending)]
    this.maybeSummarize()
    if (!this.running) void this.run()
  }

  private async run(): Promise<void> {
    this.running = true
    try {
      while (this.queue.length && !this.disposed) {
        this.onStatus({ state: 'checking', remaining: this.queue.length })
        // One paragraph per request: benchmarks showed batching several is 40-75% slower.
        await this.checkParagraph(this.queue.shift()!)
      }
      this.onStatus({ state: 'idle' })
    } catch (err) {
      const message = cleanError(err instanceof Error ? err.message : String(err))
      if (isCancelled(message)) this.onStatus({ state: 'idle' })
      else this.onStatus({ state: 'error', message })
      this.queue = []
    } finally {
      this.running = false
    }
  }

  private async checkParagraph(text: string): Promise<void> {
    // Context comes from the paragraph's neighbours at the time of the request.
    const blocks = textBlocks(this.editor.state.doc)
    const i = blocks.findIndex((b) => b.text === text)
    if (i < 0) return // edited away while queued
    const context = {
      summary: withoutObjects(this.summary || startOfDocument(blocks, i)),
      before: withoutObjects(blocks[i - 1]?.text ?? ''),
      after: withoutObjects(blocks[i + 1]?.text ?? '')
    }

    const settings = this.getSettings()
    const requestId = newRequestId('check')
    this.currentRequest = requestId
    let raw: string
    try {
      raw = await window.api.chat({
        requestId,
        model: settings.liveModel,
        // Image placeholders are left out; suggestions are still found in the full paragraph text.
        messages: checkMessages(withoutObjects(text), context, findStyle(settings.styles, settings.activeStyleId)),
        schema: CHECK_SCHEMA,
        temperature: 0.2,
        numCtx: LIVE_CTX,
        maxTokens: 1200
      })
    } finally {
      this.currentRequest = null
    }

    let items: RawSuggestion[] = []
    try {
      items = parseJson<{ suggestions: RawSuggestion[] }>(raw).suggestions ?? []
    } catch {
      return // unreadable answer: skip this paragraph quietly
    }
    this.showSuggestions(text, items)
  }

  /** Puts a paragraph's suggestions into the editor (finding the paragraph again by its text). */
  private showSuggestions(text: string, items: RawSuggestion[]): void {
    // The paragraph may have moved while the model was thinking.
    const block = textBlocks(this.editor.state.doc).find((b) => b.text === text)
    if (!block) return
    this.checked.add(text)
    const start = block.pos + 1
    const found = locateSuggestions(text, start, items, this.getIgnored())
    const meta: SuggestionMeta = { clearRange: { from: start, to: start + block.node.content.size }, add: found }
    this.editor.view.dispatch(this.editor.state.tr.setMeta(suggestionKey, meta).setMeta('addToHistory', false))
  }

  /** Keeps a short summary of long documents so checks understand the whole text. */
  private maybeSummarize(): void {
    const docText = this.editor.state.doc.textBetween(0, this.editor.state.doc.content.size, '\n\n')
    if (docText.length < 2500 || this.summarizing) return
    if (this.summary && Math.abs(docText.length - this.summaryLength) < 2000) return
    this.summarizing = true
    const settings = this.getSettings()
    window.api
      .chat({
        requestId: newRequestId('summary'),
        model: settings.liveModel,
        messages: summaryMessages(docText.slice(0, 6000)),
        temperature: 0.2,
        numCtx: LIVE_CTX,
        maxTokens: 300
      })
      .then((s) => {
        this.summary = s.trim().slice(0, 600)
        this.summaryLength = docText.length
      })
      .catch(() => {})
      .finally(() => {
        this.summarizing = false
      })
  }
}

/** Orders blocks by distance from the cursor: the paragraph being edited comes first. */
export function orderByCursor<T extends { pos: number; node: { nodeSize: number } }>(blocks: T[], cursor: number): T[] {
  const distance = (b: T) => (cursor < b.pos ? b.pos - cursor : cursor > b.pos + b.node.nodeSize ? cursor - (b.pos + b.node.nodeSize) : 0)
  return [...blocks].sort((a, b) => distance(a) - distance(b))
}

/** Splits a batch answer into one suggestion list per paragraph (missing entries → empty). */
export function splitBatchResult(result: { paragraphs?: { index: number; suggestions?: RawSuggestion[] }[] }, count: number): RawSuggestion[][] {
  const out: RawSuggestion[][] = Array.from({ length: count }, () => [])
  ;(result.paragraphs ?? []).forEach((p, i) => {
    // Trust the index when it's valid, otherwise fall back to the position in the list.
    const idx = Number.isInteger(p.index) && p.index >= 0 && p.index < count ? p.index : i
    if (idx < count && Array.isArray(p.suggestions)) out[idx].push(...p.suggestions)
  })
  return out
}

function startOfDocument(blocks: TextBlock[], skip: number): string {
  const text = blocks
    .filter((_, i) => i !== skip)
    .map((b) => b.text)
    .join('\n')
  return text.length > 800 ? text.slice(0, 800) + '…' : text
}

export function isCancelled(message: string): boolean {
  return /\bcancelled\b/.test(message)
}

export function cleanError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
