import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { marked } from 'marked'
import type { AwdFile, DocNode, ExportFormat, HistoryEntry, LibraryItem, OpenResult, Settings } from '../../shared/types'
import { LibraryDialog } from './components/LibraryDialog'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { AiChange } from './editor/aiChange'
import { Image as ImageNode, behindImageAt, embedLinkedImages, isSupportedImageSrc, MAX_IMAGE_BYTES, PAGE_TEXT_WIDTH, rememberLink } from './editor/image'
import {
  changeIdsInDoc,
  checkUndo,
  contentJson,
  replaceFromTagged,
  replaceKeepingStyle,
  restoreOriginal,
  stripTags,
  textOf,
  toTagged,
  type TaggedText
} from './editor/changes'
import { getSuggestions, suggestionKey, Suggestions, type Suggestion, type SuggestionMeta } from './editor/suggestions'
import { cleanError, isCancelled, LiveChecker, newRequestId, type CheckStatus } from './ai/liveChecker'
import { IMPROVE_SCHEMA, LIVE_CTX, improveMessages, parseJson } from './ai/prompts'
import { ZoomControl, useZoom } from './components/ZoomControl'
import { SetupDialog } from './components/SetupDialog'
import { setLanguage, t, tn } from './i18n'
import { Toolbar } from './components/Toolbar'
import { SuggestionPopup, type PopupView } from './components/SuggestionPopup'
import { HistoryPanel } from './components/HistoryPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { RewriteDialog, type RewriteChange } from './components/RewriteDialog'
import { printHtml } from './printHtml'
import { StylesDialog } from './components/StylesDialog'
import { findStyle, type WritingStyle } from '../../shared/styles'

interface DocInfo {
  path: string | null
  name: string
  createdAt: string
}

type Popup =
  | { kind: 'suggestion'; sug: Suggestion; view: PopupView }
  | {
      kind: 'improve'
      from: number
      to: number
      original: string
      requestId: string
      /** The selection with its formatting as tags (what the model was given). */
      formatting: TaggedText
      /** `rewrite` is plain text (shown); `tagged` carries the formatting tags (applied). */
      result?: { rewrite: string; tagged: string; reason: string }
      view: PopupView
    }

const newDocInfo = (): DocInfo => ({ path: null, name: 'Untitled', createdAt: new Date().toISOString() })
const newChangeId = (): string => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')
}

/** Counts English words plus individual Chinese characters. */
function countWords(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length
  const words = (text.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9À-ɏ'’-]+/g) ?? []).length
  return cjk + words
}

/** Ctrl+Shift+I runs "Improve selection". */
const AssistKeys = Extension.create<{ onImprove: () => void }>({
  name: 'assistKeys',
  addOptions: () => ({ onImprove: () => {} }),
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-i': () => {
        this.options.onImprove()
        return true
      }
    }
  }
})

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [docInfo, setDocInfo] = useState<DocInfo>(newDocInfo)
  const [dirty, setDirty] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [ignored, setIgnored] = useState<string[]>([])
  const [presentIds, setPresentIds] = useState<Set<string>>(new Set())
  const [wordCount, setWordCount] = useState(0)
  const [checkStatus, setCheckStatus] = useState<CheckStatus>({ state: 'idle' })
  // The Ollama connection, shown in the status bar (text made at render time, in the current language).
  const [ollamaStatus, setOllamaStatus] = useState<{ state: 'connecting' | 'starting' | 'ok' | 'missing' | 'down'; models?: string }>({ state: 'connecting' })
  const [showSetup, setShowSetup] = useState(false)
  /** The Setup window opens by itself once, at start, when Ollama or a model is missing. */
  const setupOffered = useRef(false)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showMarks, setShowMarks] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showRewrite, setShowRewrite] = useState(false)
  const [showStyles, setShowStyles] = useState(false)
  const [libraryMode, setLibraryMode] = useState<'open' | 'save' | null>(null)
  /** Unsaved work found at startup, offered in a bar until restored or discarded. */
  const [recovery, setRecovery] = useState<{ data: AwdFile; path: string | null; savedAt: string } | null>(null)
  const isWeb = window.api.mode === 'web'
  const [notice, setNotice] = useState<string | null>(null)

  // Refs give long-lived callbacks (editor plugins, checker, menu) the latest state.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const ignoredRef = useRef(new Set(ignored))
  ignoredRef.current = new Set(ignored)
  const checkerRef = useRef<LiveChecker | null>(null)
  const activateRef = useRef<(s: Suggestion | null, view: EditorView) => void>(() => {})
  const improveRef = useRef<() => void>(() => {})
  const scrollerRef = useRef<HTMLDivElement>(null)
  const insertImageRef = useRef<(file: File, at?: number, path?: string) => Promise<void>>(async () => {})
  const loadingRef = useRef(false)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      TextStyle,
      FontFamily,
      FontSize,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      AiChange,
      ImageNode,
      Suggestions.configure({ onActivate: (s, view) => activateRef.current(s, view) }),
      AssistKeys.configure({ onImprove: () => improveRef.current() })
    ],
    content: '<p></p>',
    autofocus: true,
    editorProps: {
      attributes: { spellcheck: 'false', class: 'page' },
      // Pasting or dropping JPG/PNG files inserts them as images.
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter(isImageFile)
        if (!files.length) return false
        files.forEach((f) => void insertImageRef.current(f))
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter(isImageFile)
        if (moved || !files.length) return false
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        files.forEach((f) => void insertImageRef.current(f, at))
        return true
      },
      handleDOMEvents: {
        // Images "behind text" lie under the paragraphs: a click on them (not on text) selects them.
        mousedown: (view, event) => {
          const hit = behindImageAt(view, event.clientX, event.clientY)
          if (!hit) return false
          event.preventDefault()
          hit.dispatchEvent(new MouseEvent('mousedown', event))
          return true
        }
      }
    },
    onUpdate: ({ editor: e }) => {
      if (!loadingRef.current) setDirty(true)
      checkerRef.current?.schedule()
      const doc = e.state.doc
      setWordCount(countWords(doc.textBetween(0, doc.content.size, ' ')))
      setPresentIds(changeIdsInDoc(doc))
    }
  })

  const flash = useCallback((text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000)
  }, [])

  // ---- Startup: settings, Ollama connection, live checker, recovery ---------

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setLanguage(s.uiLanguage)
      setSettings(s)
      checkOllama(s)
    })
  }, [])

  const checkOllama = async (s: Settings) => {
    try {
      // Desktop: start Ollama if it's installed but not running (it closes with the app).
      if (window.api.ensureOllama) {
        setOllamaStatus({ state: 'starting' })
        const state = await window.api.ensureOllama().catch(() => null)
        if (state && !state.running) {
          setOllamaStatus({ state: 'down' })
          if (!setupOffered.current) {
            setupOffered.current = true
            setShowSetup(true)
          }
          return
        }
      }
      const models = await window.api.listModels(s.ollamaUrl)
      const missing = [s.liveModel, s.rewriteModel].filter((m) => !models.includes(m))
      if (missing.length && window.api.setupStatus && !setupOffered.current) {
        setupOffered.current = true
        setShowSetup(true)
      }
      setOllamaStatus(missing.length ? { state: 'missing', models: missing.join(', ') } : { state: 'ok', models: s.liveModel })
      // Load the live model now, so the first check doesn't wait for it.
      if (models.includes(s.liveModel)) window.api.warmUp(s.liveModel, LIVE_CTX).catch(() => {})
    } catch {
      setOllamaStatus({ state: 'down' })
    }
  }

  useEffect(() => {
    if (!editor) return
    const checker = new LiveChecker(editor, () => settingsRef.current, () => ignoredRef.current, setCheckStatus)
    checkerRef.current = checker
    return () => checker.dispose()
  }, [editor])

  useEffect(() => {
    if (!editor) return
    // No pop-ups here: a blocking dialog at startup can stop the window from ever appearing.
    const startup = async () => {
      const rec = await window.api.loadRecovery().catch(() => null)
      if (rec) setRecovery(rec)
      try {
        const initial = await window.api.openInitialFile()
        if (initial) await loadOpenResult(initial)
      } catch (err) {
        flash(t('Could not open the file: ') + cleanError(err instanceof Error ? err.message : String(err)))
      }
    }
    void startup()
  }, [editor])

  // Keep the window title / close-warning in sync.
  useEffect(() => {
    window.api.setDirty(dirty, docInfo.name)
  }, [dirty, docInfo.name])

  // Periodic recovery copy while there are unsaved changes.
  useEffect(() => {
    if (!dirty || !editor) return
    const t = window.setInterval(() => {
      window.api.saveRecovery(buildAwd(), docInfo.path).catch(() => {})
    }, settings.autosaveSec * 1000)
    return () => window.clearInterval(t)
  })

  // ---- Document helpers -------------------------------------------------------

  const buildAwd = (): AwdFile => ({
    format: 'assist-writer',
    version: 1,
    content: editor!.getJSON() as DocNode,
    history,
    ignored,
    createdAt: docInfo.createdAt,
    updatedAt: new Date().toISOString()
  })

  /** Replaces the editor content without marking the document dirty. */
  const setContent = (content: string | DocNode) => {
    if (!editor) return
    loadingRef.current = true
    checkerRef.current?.reset()
    setPopup(null)
    editor.commands.setContent(content as any, { emitUpdate: true })
    // A fresh document shouldn't be undoable back to the previous one: rebuild the
    // state so the undo history (and suggestions) start empty.
    const { doc, schema, plugins } = editor.state
    editor.view.updateState(EditorState.create({ doc, schema, plugins }))
    loadingRef.current = false
    setDirty(false)
    editor.commands.focus('start')
  }

  const loadAwd = (data: AwdFile, path: string | null) => {
    setHistory(data.history ?? [])
    setIgnored(data.ignored ?? [])
    setDocInfo({ path, name: path ? baseName(path) : 'Recovered document', createdAt: data.createdAt ?? new Date().toISOString() })
    setContent(data.content)
  }

  const confirmDiscard = (): boolean =>
    !dirty || window.confirm(t('You have unsaved changes. Discard them?'))

  // ---- File actions -------------------------------------------------------------

  const newDoc = () => {
    if (!confirmDiscard()) return
    setHistory([])
    setIgnored([])
    setDocInfo(newDocInfo())
    setContent('<p></p>')
    window.api.clearRecovery()
  }

  const openDoc = async () => {
    if (!confirmDiscard()) return
    if (isWeb) {
      setLibraryMode('open')
      return
    }
    try {
      const res = await window.api.openFile()
      if (!res) return
      await loadOpenResult(res)
      window.api.clearRecovery()
    } catch (err) {
      window.alert(t('Could not open the file.') + '\n\n' + cleanError(err instanceof Error ? err.message : String(err)))
    }
  }

  const loadOpenResult = async (res: OpenResult) => {
    if (res.kind === 'awd') {
      loadAwd(res.data, res.path)
      return
    }
    setHistory([])
    setIgnored([])
    // Imported files become new documents; Save will ask where to put the .awd.
    setDocInfo({ path: null, name: res.name, createdAt: new Date().toISOString() })
    if (res.kind === 'doc') setContent(res.content)
    else if (res.kind === 'markdown') setContent((await marked.parse(res.text)) || '<p></p>')
    else setContent(textToHtml(res.text))
  }

  const markSaved = (path: string) => {
    setDocInfo((d) => ({ ...d, path, name: baseName(path) }))
    setDirty(false)
    window.api.clearRecovery()
    flash(t('Saved'))
  }

  const saveDoc = async (saveAs = false): Promise<boolean> => {
    if (!editor) return false
    if (isWeb) {
      // New documents (and Save As) pick a name in the library; otherwise save in place.
      if (!docInfo.path || saveAs) {
        setLibraryMode('save')
        return false
      }
      try {
        const item = await window.api.library!.save(docInfo.path, docInfo.name, buildAwd(), true)
        markSaved(item.id)
        return true
      } catch (err) {
        window.alert(t('Could not save.') + '\n\n' + cleanError(err instanceof Error ? err.message : String(err)))
        return false
      }
    }
    try {
      const path = await window.api.saveFile(docInfo.path, buildAwd(), saveAs)
      if (!path) return false
      markSaved(path)
      return true
    } catch (err) {
      window.alert(t('Could not save.') + '\n\n' + cleanError(err instanceof Error ? err.message : String(err)))
      return false
    }
  }

  // ---- Documents library (web version) -----------------------------------------------

  const libraryOpen = async (item: LibraryItem) => {
    const data = await window.api.library!.load(item.id)
    loadAwd(data, item.id)
    window.api.clearRecovery()
    setLibraryMode(null)
  }

  const librarySave = async (name: string, overwrite: boolean) => {
    // "Save as" under a new name creates a new document and leaves the old one as it was.
    const item = await window.api.library!.save(null, name, buildAwd(), overwrite)
    markSaved(item.id)
    setLibraryMode(null)
  }

  const libraryImport = async (file: File) => {
    const res = await window.api.library!.importFile(file)
    if (res.kind === 'awd') {
      loadAwd(res.data, null)
      setDocInfo((d) => ({ ...d, name: baseName(file.name) }))
    } else {
      await loadOpenResult(res)
    }
    window.api.clearRecovery()
    setLibraryMode(null)
  }

  const exportDoc = async (format: ExportFormat) => {
    if (!editor) return
    try {
      // Linked images are read from disk and included, so exports are complete on their own.
      const doc = await embedLinkedImages(editor.getJSON() as DocNode)
      const html = format === 'pdf' ? printHtml(editor.getHTML(), docInfo.name) : ''
      const path = await window.api.exportFile(format, doc, html, docInfo.name)
      if (path) flash(t('Exported to {path}', { path }))
    } catch (err) {
      window.alert(t('Export failed.') + '\n\n' + cleanError(err instanceof Error ? err.message : String(err)))
    }
  }

  // ---- Suggestions ------------------------------------------------------------------

  const popupViewAt = (from: number, to: number): Pick<PopupView, 'x' | 'y' | 'top'> => {
    const start = editor!.view.coordsAtPos(from)
    const end = editor!.view.coordsAtPos(to)
    return { x: start.left, y: Math.max(start.bottom, end.bottom), top: start.top }
  }

  const setActive = (id: string | null) => {
    editor?.view.dispatch(editor.state.tr.setMeta(suggestionKey, { active: id } satisfies SuggestionMeta))
  }

  activateRef.current = (s) => {
    if (!s) {
      if (popup?.kind === 'suggestion') closePopup()
      return
    }
    setActive(s.id)
    setPopup({
      kind: 'suggestion',
      sug: s,
      view: {
        ...popupViewAt(s.from, s.to),
        title: s.type === 'grammar' ? t('Grammar') : t('Style'),
        tone: s.type,
        original: s.original,
        suggestion: s.suggestion,
        reason: s.reason
      }
    })
  }

  const closePopup = () => {
    if (popup?.kind === 'improve' && !popup.result) window.api.cancelChat(popup.requestId)
    setPopup(null)
    setActive(null)
  }

  const addHistory = (entries: HistoryEntry[]) => {
    setHistory((h) => [...h, ...entries])
  }

  /**
   * Applies a replacement as a tracked AI change. Returns false if the text moved.
   * With `tagged`, formatting comes from the model's tags (translations, free rewording).
   */
  const applyChange = (
    from: number,
    to: number,
    expected: string,
    after: string,
    entry: Omit<HistoryEntry, 'id' | 'time' | 'before' | 'after'>,
    removeSuggestion?: string,
    tagged?: { text: string; formatting: TaggedText }
  ): boolean => {
    if (!editor) return false
    const state = editor.state
    if (textOf(state.doc, from, to) !== expected) {
      flash(t('The text changed in the meantime, so the suggestion was not applied.'))
      return false
    }
    const id = newChangeId()
    const beforeContent = contentJson(state.doc, from, to)
    const tr = tagged
      ? replaceFromTagged(state.tr, from, to, tagged.text, tagged.formatting, id)
      : replaceKeepingStyle(state.tr, from, to, after, id)
    tr.setMeta(suggestionKey, { removeIds: removeSuggestion ? [removeSuggestion] : [], active: null } satisfies SuggestionMeta)
    editor.view.dispatch(tr)
    addHistory([{ id, time: new Date().toISOString(), before: expected, after, beforeContent, ...entry }])
    // The edited paragraph doesn't need an immediate re-check.
    const para = editor.state.doc.resolve(Math.min(from, editor.state.doc.content.size)).parent
    checkerRef.current?.markChecked(textOf(para, 0, para.content.size))
    return true
  }

  const acceptSuggestion = () => {
    if (popup?.kind !== 'suggestion' || !editor) return
    const current = getSuggestions(editor.state).find((s) => s.id === popup.sug.id)
    if (!current) {
      closePopup()
      return
    }
    applyChange(current.from, current.to, current.original, current.suggestion, {
      kind: current.type,
      model: settings.liveModel,
      reason: current.reason
    }, current.id)
    setPopup(null)
    editor.commands.focus()
  }

  const rejectSuggestion = () => {
    if (popup?.kind === 'suggestion' && editor) {
      editor.view.dispatch(editor.state.tr.setMeta(suggestionKey, { removeIds: [popup.sug.id], active: null } satisfies SuggestionMeta))
    }
    closePopup()
    editor?.commands.focus()
  }

  const ignoreSuggestion = () => {
    if (popup?.kind !== 'suggestion' || !editor) return
    const original = popup.sug.original
    setIgnored((list) => (list.includes(original) ? list : [...list, original]))
    setDirty(true)
    // Remove every current suggestion for the same text.
    const ids = getSuggestions(editor.state).filter((s) => s.original === original).map((s) => s.id)
    editor.view.dispatch(editor.state.tr.setMeta(suggestionKey, { removeIds: ids, active: null } satisfies SuggestionMeta))
    setPopup(null)
    editor.commands.focus()
  }

  // ---- Improve selection ------------------------------------------------------------------

  const runImprove = async (from: number, to: number, original: string) => {
    if (!editor) return
    const requestId = newRequestId('improve')
    const style = findStyle(settingsRef.current.styles, settingsRef.current.activeStyleId)
    const title = style ? t('Improve · {name}', { name: style.name }) : t('Improve')
    const base: PopupView = { ...popupViewAt(from, to), title, tone: 'improve', original, loading: true }
    // The selection with its formatting as tags, so the model can keep bold/italic/fonts on
    // the matching words even when it translates or rewords them.
    const formatting = toTagged(editor.state.doc, from, to)
    setPopup({ kind: 'improve', from, to, original, requestId, formatting, view: base })
    const para = editor.state.doc.resolve(from).parent
    try {
      const raw = await window.api.chat({
        requestId,
        model: settingsRef.current.liveModel,
        messages: improveMessages(formatting.text.trim(), {
          summary: checkerRef.current?.documentSummary ?? '',
          paragraph: textOf(para, 0, para.content.size)
        }, style),
        schema: IMPROVE_SCHEMA,
        temperature: 0.5,
        numCtx: LIVE_CTX,
        maxTokens: 1500
      })
      const result = parseJson<{ rewrite: string; reason: string }>(raw)
      // Keep the selection's own leading/trailing spaces.
      const lead = /^\s*/.exec(original)![0]
      const trail = /\s*$/.exec(original)![0]
      const tagged = lead + (result.rewrite ?? '').trim() + trail
      const rewrite = stripTags(tagged)
      setPopup((p) =>
        p?.kind === 'improve' && p.requestId === requestId
          ? {
              ...p,
              result: { rewrite, tagged, reason: result.reason ?? '' },
              view: { ...p.view, loading: false, suggestion: rewrite, reason: result.reason ?? '' }
            }
          : p
      )
    } catch (err) {
      const message = cleanError(err instanceof Error ? err.message : String(err))
      if (isCancelled(message)) return
      setPopup((p) =>
        p?.kind === 'improve' && p.requestId === requestId ? { ...p, view: { ...p.view, loading: false, error: message } } : p
      )
    }
  }

  // ---- Images ------------------------------------------------------------------------------

  /**
   * Inserts a JPG/PNG at the cursor (or at `at`), in line with text, at most half a page wide.
   * A file picked or dropped from disk (`path`) is linked instead of embedded if the settings say so.
   */
  insertImageRef.current = async (file: File, at?: number, path?: string) => {
    if (!editor) return
    try {
      const link = path && settings.imageStorage === 'link' ? path : ''
      const { src, width, height } = await readImage(file, !link)
      if (link) rememberLink(link, src)
      const scale = Math.min(1, PAGE_TEXT_WIDTH / 2 / Math.max(1, width))
      const attrs = { src: link ? '' : src, link, alt: file.name, width: Math.round(width * scale), height: Math.round(height * scale), wrap: 'inline', side: 'left', valign: 'bottom', vpos: 'free', margin: 12, x: 0, y: 0 }
      const chain = editor.chain().focus()
      const sel = editor.state.selection
      if (at === undefined && sel instanceof NodeSelection && sel.node.type.name === 'image') {
        // Never replace the selected image: add the new one after it (after the paragraph's
        // text for an anchored image, which always sits at the paragraph start).
        at = sel.node.attrs.wrap === 'inline' ? sel.to : sel.$from.end()
      }
      if (at !== undefined) chain.setTextSelection(at)
      chain.insertContent({ type: 'image', attrs }).run()
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err))
    }
  }

  /** Desktop: an image file from disk, by path (picked or dropped), embedded or linked. */
  const insertImagePath = async (path: string, at?: number) => {
    if (!window.api.readImageFile) return
    try {
      const bytes = await window.api.readImageFile(path)
      const name = path.split(/[\/]/).pop() ?? 'image'
      const type = /.png$/i.test(name) ? 'image/png' : 'image/jpeg'
      await insertImageRef.current(new File([bytes as Uint8Array<ArrayBuffer>], name, { type }), at, path)
    } catch (err) {
      flash(cleanError(err instanceof Error ? err.message : String(err)))
    }
  }
  const pickImage = async () => {
    const path = await window.api.pickImage?.()
    if (path) await insertImagePath(path)
  }
  const insertImagePathRef = useRef(insertImagePath)
  insertImagePathRef.current = insertImagePath
  useEffect(() => {
    if (!editor || !window.api.onFileDrop) return
    return window.api.onFileDrop((paths, x, y) => {
      const images = paths.filter((p) => /.(png|jpe?g)$/i.test(p))
      if (!images.length) return
      const at = editor.view.posAtCoords({ left: x, top: y })?.pos
      images.forEach((p) => void insertImagePathRef.current(p, at))
    })
  }, [editor])

  improveRef.current = () => {
    if (!editor) return
    const { from, to, empty, $from, $to } = editor.state.selection
    let f = from
    let end = to
    if (empty) {
      // No selection: improve the whole current paragraph.
      f = $from.start()
      end = $from.end()
    } else if (!$from.sameParent($to)) {
      flash(t('Select text within one paragraph. Use “Rewrite doc” for larger changes.'))
      return
    }
    const original = textOf(editor.state.doc, f, end)
    if (!original.trim()) {
      flash(t('Select some text (or put the cursor in a paragraph) to improve it.'))
      return
    }
    void runImprove(f, end, original)
  }

  const acceptImprove = () => {
    if (popup?.kind !== 'improve' || !popup.result || !editor) return
    // The popup positions were taken at request time; follow later edits by re-finding the text.
    const ok = applyChange(
      popup.from,
      popup.to,
      popup.original,
      popup.result.rewrite,
      { kind: 'improve', model: settings.liveModel, reason: popup.result.reason },
      undefined,
      { text: popup.result.tagged, formatting: popup.formatting }
    )
    if (ok) setPopup(null)
    editor.commands.focus()
  }

  // ---- Rewrite whole document ------------------------------------------------------------------

  const applyRewrite = (changes: RewriteChange[]) => {
    if (!editor) return
    editor.setEditable(true)
    const tr = editor.state.tr
    const entries: HistoryEntry[] = []
    // Apply from the end so earlier positions stay valid.
    for (const c of [...changes].sort((a, b) => b.pos - a.pos)) {
      const node = tr.doc.nodeAt(c.pos)
      if (!node) continue
      const from = c.pos + 1
      const to = from + node.content.size
      if (textOf(tr.doc, from, to) !== c.before) continue
      const id = newChangeId()
      const beforeContent = contentJson(tr.doc, from, to)
      replaceFromTagged(tr, from, to, c.taggedAfter, c.formatting, id)
      entries.push({
        id,
        time: new Date().toISOString(),
        kind: 'rewrite',
        model: settings.rewriteModel,
        before: c.before,
        after: c.after,
        beforeContent,
        reason: 'Whole-document rewrite'
      })
    }
    tr.setMeta(suggestionKey, { clearAll: true } satisfies SuggestionMeta)
    editor.view.dispatch(tr)
    addHistory(entries.reverse())
    setShowRewrite(false)
    flash(tn(entries.length, 'Applied 1 paragraph change.', 'Applied {n} paragraph changes.'))
  }

  // ---- History: go to / undo one change ------------------------------------------------------------------

  const goToChange = (e: HistoryEntry) => {
    if (!editor) return
    const check = checkUndo(editor.state.doc, e.id, e.after)
    if (!check.range) return
    const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, check.range.from, check.range.to)).scrollIntoView()
    editor.view.dispatch(tr)
    editor.commands.focus()
  }

  const undoChange = (e: HistoryEntry) => {
    if (!editor) return
    const check = checkUndo(editor.state.doc, e.id, e.after)
    if (!check.range) {
      window.alert(t('This change is no longer in the document.'))
      return
    }
    if (
      check.modified &&
      !window.confirm(
        t('This text was edited after the change was made.\n\nNow:\n{now}\n\nIt will be restored to:\n{before}\n\nRestore anyway?', { now: check.current, before: e.before })
      )
    ) {
      return
    }
    // Untouched since the change: put back the exact original, formatting included.
    // Edited since: restore the text, keeping the formatting of words that are still there.
    const tr = restoreOriginal(editor.state.tr, check.range.from, check.range.to, e.before, check.modified ? undefined : e.beforeContent)
    editor.view.dispatch(tr)
    setHistory((h) => h.map((x) => (x.id === e.id ? { ...x, undone: true } : x)))
    flash(t('Change undone.'))
  }

  // ---- Settings / live toggle ------------------------------------------------------------------

  /**
   * Puts settings into effect everywhere at once: toolbar, status bar, dialogs and Live check.
   * Used for changes made here and for changes made in another window or device.
   */
  const applySettings = (next: Settings) => {
    const prev = settingsRef.current
    settingsRef.current = next
    setLanguage(next.uiLanguage)
    setSettings(next)
    if (prev.ollamaUrl !== next.ollamaUrl || prev.liveModel !== next.liveModel || prev.rewriteModel !== next.rewriteModel) {
      void checkOllama(next)
    }
    const prevStyle = findStyle(prev.styles, prev.activeStyleId)
    const newStyle = findStyle(next.styles, next.activeStyleId)
    // A different style (or an edited prompt) means Live check re-checks with the new prompt.
    const styleChanged = prevStyle?.id !== newStyle?.id || prevStyle?.prompt !== newStyle?.prompt
    if (!next.liveCheck) checkerRef.current?.stop()
    else if (styleChanged) checkerRef.current?.restyle()
    else if (!prev.liveCheck) checkerRef.current?.schedule()
  }
  const applyRef = useRef(applySettings)
  applyRef.current = applySettings

  const saveSettings = async (s: Settings) => {
    applySettings(await window.api.saveSettings(s))
  }

  // Another window (desktop app, web version, another device) changed the settings: follow them.
  useEffect(
    () =>
      window.api.onSettingsChanged(async () => {
        const fresh = await window.api.getSettings().catch(() => null)
        if (fresh && JSON.stringify(fresh) !== JSON.stringify(settingsRef.current)) applyRef.current(fresh)
      }),
    []
  )

  const setStyle = (id: string | null) => {
    void saveSettings({ ...settings, activeStyleId: id }).then(() => {
      const name = findStyle(settingsRef.current.styles, id)?.name
      flash(name ? t('Writing style: {name}', { name }) : t('Writing style: none'))
    })
  }

  const saveStyles = (styles: WritingStyle[]) => {
    const activeStyleId = styles.some((s) => s.id === settings.activeStyleId) ? settings.activeStyleId : null
    void saveSettings({ ...settings, styles, activeStyleId })
    setShowStyles(false)
  }

  const toggleLive = () => {
    void saveSettings({ ...settings, liveCheck: !settings.liveCheck })
  }

  /** English ⇄ Traditional Chinese interface, saved as a setting so every window follows. */
  const toggleLanguage = () => {
    void saveSettings({ ...settings, uiLanguage: settings.uiLanguage === 'zh-Hant' ? 'en' : 'zh-Hant' })
  }

  // ---- Menu ------------------------------------------------------------------

  const zoomRef = useRef<ReturnType<typeof useZoom> | null>(null)
  const menuRef = useRef<(action: string) => void>(() => {})
  menuRef.current = (action) => {
    if (action.startsWith('export:')) return void exportDoc(action.slice(7) as ExportFormat)
    switch (action) {
      case 'new':
        return newDoc()
      case 'open':
        return void openDoc()
      case 'save':
        return void saveDoc()
      case 'saveAs':
        return void saveDoc(true)
      case 'settings':
        return setShowSettings(true)
      case 'undo':
        return void editor?.commands.undo()
      case 'redo':
        return void editor?.commands.redo()
      case 'improve':
        return improveRef.current()
      case 'rewrite':
        return setShowRewrite(true)
      case 'checkAll':
        return checkerRef.current?.checkAll()
      case 'toggleLive':
        return toggleLive()
      case 'history':
        return setShowHistory((v) => !v)
      // The View menu's zoom drives the page zoom (the same as the toolbar and Ctrl + wheel).
      case 'setup':
        return window.api.setupStatus ? setShowSetup(true) : undefined
      case 'zoomIn':
        return zoomRef.current?.zoomBy(1)
      case 'zoomOut':
        return zoomRef.current?.zoomBy(-1)
      case 'zoomReset':
        return zoomRef.current?.setMode(1)
    }
  }
  useEffect(() => window.api.onMenu((a) => menuRef.current(a)), [])

  // Close the popup when its suggestion disappears (e.g. the text was edited).
  useEffect(() => {
    if (!editor || popup?.kind !== 'suggestion') return
    const check = () => {
      if (!getSuggestions(editor.state).some((s) => s.id === popup.sug.id)) setPopup(null)
    }
    editor.on('transaction', check)
    return () => {
      editor.off('transaction', check)
    }
  }, [editor, popup])

  const zoom = useZoom(scrollerRef, !!editor)
  zoomRef.current = zoom

  // The desktop menu and prompts follow the interface language.
  useEffect(() => {
    window.api.setLanguage?.(settings.uiLanguage)
  }, [settings.uiLanguage])

  if (!editor) return null

  const activeStyle = findStyle(settings.styles, settings.activeStyleId)

  const statusText =
    checkStatus.state === 'checking'
      ? tn(checkStatus.remaining, 'Checking… (1 paragraph)', 'Checking… ({n} paragraphs)')
      : checkStatus.state === 'error'
        ? checkStatus.message
        : settings.liveCheck
          ? t('Live check on')
          : t('Live check off')

  return (
    <div className={`app${showMarks ? ' show-marks' : ''}`}>
      <Toolbar
        editor={editor}
        liveCheck={settings.liveCheck}
        historyOpen={showHistory}
        onNew={newDoc}
        onOpen={openDoc}
        onSave={() => void saveDoc()}
        onExport={exportDoc}
        onImprove={() => improveRef.current()}
        onRewrite={() => setShowRewrite(true)}
        onToggleLive={toggleLive}
        onToggleHistory={() => setShowHistory((v) => !v)}
        onSettings={() => setShowSettings(true)}
        zoom={<ZoomControl mode={zoom.mode} zoom={zoom.zoom} onMode={zoom.setMode} onStep={zoom.zoomBy} />}
        onInsertImage={(file) => void insertImageRef.current(file)}
        onPickImage={window.api.pickImage ? () => void pickImage() : undefined}
        styles={settings.styles}
        activeStyleId={settings.activeStyleId}
        onStyleChange={setStyle}
        onManageStyles={() => setShowStyles(true)}
        language={settings.uiLanguage}
        onToggleLanguage={toggleLanguage}
      />

      {recovery && (
        <div className="recovery-bar">
          <span>
            {recovery.path
              ? t('Unsaved work from {time} ({name}) was found.', { time: new Date(recovery.savedAt).toLocaleString(), name: baseName(recovery.path) })
              : t('Unsaved work from {time} was found.', { time: new Date(recovery.savedAt).toLocaleString() })}
          </span>
          <button
            className="primary"
            onClick={() => {
              if (!confirmDiscard()) return
              loadAwd(recovery.data, recovery.path)
              setDirty(true)
              setRecovery(null)
            }}
          >
            {t('Restore it')}
          </button>
          <button
            onClick={() => {
              window.api.clearRecovery()
              setRecovery(null)
            }}
          >
            {t('Discard')}
          </button>
        </div>
      )}

      <div className="workspace">
        <div className="scroller" ref={scrollerRef} onScroll={() => popup && closePopup()}>
          <EditorContent editor={editor} />
        </div>
        {showHistory && (
          <HistoryPanel
            history={history}
            presentIds={presentIds}
            showMarks={showMarks}
            onToggleMarks={() => setShowMarks((v) => !v)}
            onGoTo={goToChange}
            onUndo={undoChange}
            onClose={() => setShowHistory(false)}
          />
        )}
      </div>

      <footer className="statusbar">
        <span>
          {dirty ? '● ' : ''}
          {docInfo.name === 'Untitled' ? t('Untitled') : docInfo.name}
        </span>
        <span
          className={ollamaStatus.state === 'down' || ollamaStatus.state === 'missing' ? 'bad' : 'ok'}
          title={t('Click to open settings')}
          onClick={() => (window.api.setupStatus && (ollamaStatus.state === 'down' || ollamaStatus.state === 'missing') ? setShowSetup(true) : setShowSettings(true))}
        >
          {ollamaStatus.state === 'connecting'
            ? t('Connecting to Ollama…')
            : ollamaStatus.state === 'starting'
              ? t('Starting Ollama…')
              : ollamaStatus.state === 'down'
                ? t('Ollama is not running')
                : ollamaStatus.state === 'missing'
                  ? t('Model not installed: {models}', { models: ollamaStatus.models ?? '' })
                  : `Ollama · ${ollamaStatus.models}`}
        </span>
        <span className={checkStatus.state === 'error' ? 'bad' : ''}>
          {checkStatus.state === 'checking' && <span className="spinner small" />} {statusText}
        </span>
        <span
          className="style-indicator"
          title={
            activeStyle
              ? t('Writing style used by Live check, Improve and Rewrite doc:') + `\n${activeStyle.name}\n\n${activeStyle.prompt.slice(0, 400)}${activeStyle.prompt.length > 400 ? '…' : ''}\n\n` + t('Click to manage styles.')
              : t('No writing style: general improvements. Click to manage styles.')
          }
          onClick={() => setShowStyles(true)}
        >
          {activeStyle ? t('Style: {name}', { name: activeStyle.name }) : t('Style: none')}
        </span>
        <span className="spacer" />
        {notice && <span className="notice">{notice}</span>}
        <span>{tn(wordCount, '1 word', '{n} words')}</span>
      </footer>

      {popup?.kind === 'suggestion' && (
        <SuggestionPopup view={popup.view} onAccept={acceptSuggestion} onReject={rejectSuggestion} onIgnore={ignoreSuggestion} />
      )}
      {popup?.kind === 'improve' && (
        <SuggestionPopup
          view={popup.view}
          onAccept={acceptImprove}
          onReject={() => {
            closePopup()
            editor.commands.focus()
          }}
          onRetry={() => void runImprove(popup.from, popup.to, popup.original)}
        />
      )}

      {showSetup && <SetupDialog settings={settings} onChanged={() => void checkOllama(settingsRef.current)} onClose={() => setShowSetup(false)} />}
      {showSettings && (
        <SettingsDialog
          onSetup={window.api.setupStatus ? () => setShowSetup(true) : undefined}
          settings={settings}
          onSave={(s) => void saveSettings(s).then(() => setShowSettings(false))}
          onStyleChange={setStyle}
          onSaveStyles={saveStyles}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showStyles && <StylesDialog styles={settings.styles} onSave={saveStyles} onClose={() => setShowStyles(false)} />}
      {libraryMode && (
        <LibraryDialog
          mode={libraryMode}
          currentId={docInfo.path}
          currentName={docInfo.name}
          onOpen={libraryOpen}
          onSave={librarySave}
          onImport={libraryImport}
          onRenamed={(oldId, item) => {
            if (oldId === docInfo.path) setDocInfo((d) => ({ ...d, path: item.id, name: item.name }))
          }}
          onDeleted={(id) => {
            // The open document stays in the editor but now has no saved copy.
            if (id === docInfo.path) {
              setDocInfo((d) => ({ ...d, path: null }))
              setDirty(true)
            }
          }}
          onClose={() => setLibraryMode(null)}
        />
      )}
      {showRewrite && (
        <RewriteDialog
          editor={editor}
          settings={settings}
          onStyleChange={setStyle}
          onApply={applyRewrite}
          onClose={() => setShowRewrite(false)}
        />
      )}
    </div>
  )
}

const isImageFile = (f: File) => /^image\/(png|jpeg)$/.test(f.type) || /\.(png|jpe?g)$/i.test(f.name)

/** Reads a JPG/PNG file as a data URL plus its natural size. */
function readImage(file: File, embed = true): Promise<{ src: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    if (!isImageFile(file)) return reject(new Error(t('Only JPG and PNG images are supported.')))
    if (embed && file.size > MAX_IMAGE_BYTES) return reject(new Error(t('This image is larger than 15 MB.')))
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(t('This image could not be read.')))
    reader.onload = () => {
      let src = String(reader.result)
      // Some drag sources give no file type; use the extension instead.
      if (!isSupportedImageSrc(src)) src = src.replace(/^data:[^;,]*/, /\.png$/i.test(file.name) ? 'data:image/png' : 'data:image/jpeg')
      const img = new window.Image()
      img.onload = () => resolve({ src, width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => reject(new Error(t('This image could not be read.')))
      img.src = src
    }
    reader.readAsDataURL(file)
  })
}

function baseName(path: string): string {
  return path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
}
