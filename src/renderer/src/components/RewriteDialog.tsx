import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { Settings } from '../../../shared/types'
import { cleanError, isCancelled, newRequestId, textBlocks } from '../ai/liveChecker'
import { LIVE_CTX, parseJson, rewriteMessages, rewriteSchema } from '../ai/prompts'
import { findStyle } from '../../../shared/styles'
import { forDisplay, stripTags, toTagged, type TaggedText } from '../editor/changes'
import { t, tn } from '../i18n'

export interface RewriteChange {
  pos: number
  /** Plain text before and after (shown in the review, kept in the history). */
  before: string
  after: string
  /** The model's output with formatting tags, and what each tag stands for. */
  taggedAfter: string
  formatting: TaggedText
}

interface Props {
  editor: Editor
  settings: Settings
  /** Changes the one active writing style (used everywhere, not just for this rewrite). */
  onStyleChange: (id: string | null) => void
  onApply: (changes: RewriteChange[]) => void
  onClose: () => void
}

type Stage = 'setup' | 'running' | 'review'

interface Item extends RewriteChange {
  index: number
  accepted: boolean
}

/** Rough token estimate: ~1 token per CJK char, ~1 per 4 Latin chars. */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[　-鿿＀-￯]/g) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

export function RewriteDialog({ editor, settings, onStyleChange, onApply, onClose }: Props) {
  const blocks = useMemo(() => textBlocks(editor.state.doc), [editor])
  // Each paragraph with its formatting as tags, so the model can carry bold/italic/fonts over
  // to the matching words even when it translates or rewords everything.
  const tagged = useMemo(
    () => blocks.map((b) => toTagged(editor.state.doc, b.pos + 1, b.pos + 1 + b.node.content.size)),
    [blocks, editor]
  )
  const [stage, setStage] = useState<Stage>('setup')
  const [instruction, setInstruction] = useState('')
  const [streamed, setStreamed] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const requestRef = useRef<string | null>(null)
  const [gpuPct, setGpuPct] = useState<number | null>(null)

  // The document is locked while the rewrite runs so paragraph positions stay valid (without
  // counting as an edit: false = no update event, so the document isn't marked unsaved).
  useEffect(() => {
    editor.setEditable(false, false)
    return () => {
      editor.setEditable(true, false)
      if (requestRef.current) window.api.cancelChat(requestRef.current)
    }
  }, [editor])

  const start = async () => {
    setError(null)
    setStreamed('')
    setStage('running')
    const requestId = newRequestId('rewrite')
    requestRef.current = requestId
    const off = window.api.onChatChunk((id, chunk) => {
      if (id === requestId) setStreamed((s) => s + chunk)
    })
    const separateModels = settings.rewriteModel !== settings.liveModel
    try {
      const texts = tagged.map((t) => t.text)
      // Room for the document going in and its rewrite coming out, plus the instructions.
      const tokens = estimateTokens(texts.join('\n'))
      const numCtx = Math.min(65536, Math.max(8192, Math.ceil((tokens * 2.2 + 1024) / 2048) * 2048))
      // Free the GPU for the big model: two models in memory at once push one onto the CPU.
      if (separateModels) await window.api.unloadModel(settings.liveModel).catch(() => {})
      const raw = await window.api.chat({
        requestId,
        model: settings.rewriteModel,
        messages: rewriteMessages(texts, instruction, findStyle(settings.styles, settings.activeStyleId)),
        schema: rewriteSchema(texts.length),
        temperature: 0.4,
        numCtx,
        // A rewrite is about as long as the original; the cap stops a model that starts rambling.
        maxTokens: Math.ceil(tokens * 2.5 + texts.length * 64 + 256),
        keepAlive: '2m',
        stream: true
      })
      // How much of the model ran on the GPU (anything less is much slower).
      const loaded = (await window.api.loadedModels().catch(() => [])).find((m) => m.name === settings.rewriteModel)
      setGpuPct(loaded && loaded.size ? Math.round((loaded.sizeVram / loaded.size) * 100) : null)
      const result = parseJson<{ paragraphs: { index: number; text: string }[] }>(raw).paragraphs ?? []
      const byIndex = new Map(result.map((r) => [r.index, r.text]))
      const changed: Item[] = []
      blocks.forEach((b, index) => {
        const out = byIndex.get(index)
        if (typeof out !== 'string') return
        const plain = stripTags(out).trim()
        if (plain && plain !== b.text.trim()) {
          // Keep the paragraph's own leading/trailing whitespace.
          const lead = /^\s*/.exec(b.text)![0]
          const trail = /\s*$/.exec(b.text)![0]
          changed.push({
            index,
            pos: b.pos,
            before: b.text,
            after: lead + plain + trail,
            taggedAfter: lead + out.trim() + trail,
            formatting: tagged[index],
            accepted: true
          })
        }
      })
      setItems(changed)
      setStage('review')
    } catch (err) {
      const message = cleanError(err instanceof Error ? err.message : String(err))
      if (isCancelled(message)) {
        setStage('setup')
      } else {
        setError(message)
        setStage('setup')
      }
    } finally {
      off()
      requestRef.current = null
      // Put the live model back so checking while you type stays fast.
      if (separateModels) {
        void window.api
          .unloadModel(settings.rewriteModel)
          .catch(() => {})
          .then(() => window.api.warmUp(settings.liveModel, LIVE_CTX))
          .catch(() => {})
      }
    }
  }

  const cancel = () => {
    if (requestRef.current) window.api.cancelChat(requestRef.current)
  }

  const toggle = (i: number) => setItems((list) => list.map((it, j) => (j === i ? { ...it, accepted: !it.accepted } : it)))
  const setAll = (accepted: boolean) => setItems((list) => list.map((it) => ({ ...it, accepted })))
  const acceptedCount = items.filter((i) => i.accepted).length

  const progress = (() => {
    const done = (streamed.match(/"index"/g) ?? []).length
    return t('{done} / {total} paragraphs', { done: Math.min(done, blocks.length), total: blocks.length })
  })()

  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <h2>{t('Rewrite whole document')}</h2>

        {stage === 'setup' && (
          <>
            <p>
              {tn(blocks.length, "The document's 1 paragraph will be rewritten by {model}. You'll review every changed paragraph before anything is replaced.", "The document's {n} paragraphs will be rewritten by {model}. You'll review every changed paragraph before anything is replaced.", { model: settings.rewriteModel })}
            </p>
            <label className="field">
              <span>{t('Writing style')}</span>
              <select value={settings.activeStyleId ?? ''} onChange={(e) => onStyleChange(e.target.value || null)}>
                <option value="">{t('None (general improvements)')}</option>
                {settings.styles.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
              <small className="muted">{t("This is the app's one writing style: changing it here also changes Live check and Improve.")}</small>
            </label>
            <label className="field">
              <span>{t('Extra instruction (optional)')}</span>
              <input
                placeholder={t('e.g. make it more formal / 更加生動 / keep it concise')}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
            {error && <p className="bad">{error}</p>}
            <div className="modal-actions">
              <button onClick={onClose}>{t('Cancel')}</button>
              <button className="primary" disabled={blocks.length === 0} onClick={start}>
                {t('Start rewrite')}
              </button>
            </div>
          </>
        )}

        {stage === 'running' && (
          <>
            <p>
              <span className="spinner" /> {t('Rewriting… {progress}', { progress })}
            </p>
            <p className="muted">{t('Large models can take a few minutes for a long document.')}</p>
            <pre className="stream-preview">{streamed.slice(-600) || t('Loading model…')}</pre>
            <div className="modal-actions">
              <button onClick={cancel}>{t('Stop')}</button>
            </div>
          </>
        )}

        {stage === 'review' && (
          <>
            {gpuPct !== null && gpuPct < 95 && (
              <p className="bad">
                {t("Only {pct}% of {model} fit in your graphics card's memory, so the rest ran on the CPU and the rewrite was much slower. Choose a smaller rewrite model in Settings for faster results.", { pct: gpuPct, model: settings.rewriteModel })}
              </p>
            )}
            {items.length === 0 ? (
              <p>{t("The model didn't suggest any changes.")}</p>
            ) : (
              <>
                <div className="row">
                  <span>
                    {tn(items.length, '1 paragraph changed. Tick the ones to apply.', '{n} paragraphs changed. Tick the ones to apply.')}
                  </span>
                  <span className="spacer" />
                  <button onClick={() => setAll(true)}>{t('Select all')}</button>
                  <button onClick={() => setAll(false)}>{t('Select none')}</button>
                </div>
                <ul className="rewrite-list">
                  {items.map((it, i) => (
                    <li key={it.index} className={it.accepted ? '' : 'inactive'} onClick={() => toggle(i)}>
                      <input type="checkbox" checked={it.accepted} readOnly />
                      <div className="cols">
                        <div className="before">{forDisplay(it.before)}</div>
                        <div className="after">{forDisplay(it.after)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  {t('Formatting is kept: unchanged words keep their style, and reworded words take the style of the words they replace.')}
                </p>
              </>
            )}
            <div className="modal-actions">
              <button onClick={onClose}>{items.length ? t('Discard') : t('Close')}</button>
              {items.length > 0 && (
                <button className="primary" disabled={acceptedCount === 0} onClick={() => onApply(items.filter((i) => i.accepted))}>
                  {tn(acceptedCount, 'Apply 1 change', 'Apply {n} changes')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
