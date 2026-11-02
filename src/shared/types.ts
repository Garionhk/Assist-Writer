// Types shared by the main process, preload and renderer.
import { DEFAULT_STYLES, type WritingStyle } from './styles'
export type { WritingStyle } from './styles'

/** Minimal shape of TipTap/ProseMirror JSON, enough for the exporters. */
export interface DocNode {
  type: string
  attrs?: Record<string, any>
  content?: DocNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, any> }[]
}

export interface Settings {
  ollamaUrl: string
  /** Fast model used for live grammar/style checking and "Improve selection". */
  liveModel: string
  /** Larger model used for "Rewrite whole document". */
  rewriteModel: string
  liveCheck: boolean
  /** Pause after typing before a check is sent (ms). */
  debounceMs: number
  /** Autosave-to-recovery interval (seconds). */
  autosaveSec: number
  /** Writing styles the user can pick from (built-in ones plus their own). */
  styles: WritingStyle[]
  /** Selected style, or null for no particular style. */
  activeStyleId: string | null
  /**
   * How inserted image files are kept (desktop app): 'embed' copies the image into the document,
   * 'link' stores only the file's path. Pasted images are always embedded; the web version always embeds.
   */
  imageStorage: 'embed' | 'link'
  /** Interface language: English or Traditional Chinese. */
  uiLanguage: 'en' | 'zh-Hant'
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://localhost:11434',
  liveModel: 'qwen3.5:9b',
  // Fits fully in a 16 GB GPU: ~3x faster rewrites than the 18 GB build, same quality in our benchmark.
  rewriteModel: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL',
  liveCheck: true,
  debounceMs: 1500,
  autosaveSec: 30,
  styles: DEFAULT_STYLES,
  activeStyleId: null,
  imageStorage: 'embed',
  uiLanguage: 'en'
}

export type ChangeKind = 'grammar' | 'style' | 'improve' | 'rewrite'

/** One accepted AI change. `id` matches the aiChange mark left in the document. */
export interface HistoryEntry {
  id: string
  time: string
  kind: ChangeKind
  model: string
  before: string
  after: string
  /** The original text with its formatting (editor JSON), so undo restores it exactly. */
  beforeContent?: unknown[]
  reason: string
  undone?: boolean
}

/** The .awd file format (JSON). */
export interface AwdFile {
  format: 'assist-writer'
  version: 1
  content: DocNode
  history: HistoryEntry[]
  /** Suggestions the user chose "Ignore always" for, keyed by original text. */
  ignored: string[]
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  requestId: string
  model: string
  messages: ChatMessage[]
  /** JSON schema passed as Ollama's `format`. */
  schema?: object
  temperature?: number
  /** Context window size (tokens); needed for long documents. */
  numCtx?: number
  /** Upper limit on the length of the answer (tokens). */
  maxTokens?: number
  /** How long Ollama keeps the model loaded afterwards (e.g. '30m', or 0 to unload at once). */
  keepAlive?: string | number
  /** Stream partial output back through the `ollama:chunk` event. */
  stream?: boolean
}

export type ExportFormat = 'pdf' | 'docx' | 'rtf' | 'md' | 'txt'

export type OpenResult =
  | { kind: 'awd'; path: string; data: AwdFile }
  /** Already in the editor's document format (e.g. read from a Word file). */
  | { kind: 'doc'; name: string; content: DocNode }
  | { kind: 'markdown'; name: string; text: string }
  | { kind: 'text'; name: string; text: string }

/** Ollama on this PC (desktop app). */
export interface OllamaState {
  installed: boolean
  running: boolean
  /** Assist Writer started this Ollama server and stops it when it closes. */
  startedByApp: boolean
  version: string | null
  path: string | null
}

export interface SetupStatus {
  ollama: OllamaState
  gpus: { name: string; vramBytes: number }[]
  /** Installed models and their sizes (bytes). */
  models: [string, number][]
}

export interface SetupProgress {
  status: string
  completed: number
  total: number
}

/** A model Ollama currently has in memory, and how much of it sits in GPU memory (bytes). */
export interface LoadedModel {
  name: string
  size: number
  sizeVram: number
}

/** A document in the documents library (web version). `id` is its file name. */
export interface LibraryItem {
  id: string
  name: string
  updatedAt: string
  size: number
}

export interface AccessInfo {
  /** True when the browser is on the same PC as the server. */
  isLocal: boolean
  passwordSet: boolean
  /** Addresses other devices on the network can use. */
  urls: string[]
}

/**
 * API used by the UI as `window.api`. The desktop app gets it from the preload script
 * (Electron IPC); the web version gets an HTTP implementation talking to the local server.
 */
export interface Api {
  mode: 'desktop' | 'web'

  /** Web only: the documents library. */
  library?: {
    list(): Promise<LibraryItem[]>
    load(id: string): Promise<AwdFile>
    save(id: string | null, name: string, data: AwdFile, overwrite?: boolean): Promise<LibraryItem>
    rename(id: string, name: string): Promise<LibraryItem>
    remove(id: string): Promise<void>
    importFile(file: File): Promise<OpenResult>
  }
  /** Web only: network access / password. */
  access?: {
    info(): Promise<AccessInfo>
    setPassword(password: string): Promise<void>
  }

  getSettings(): Promise<Settings>
  /** Desktop only: starts Ollama if it's installed but not running. */
  ensureOllama?(): Promise<OllamaState>
  /** Desktop only: Ollama, graphics cards and installed models, for the Setup window. */
  setupStatus?(): Promise<SetupStatus>
  /** Desktop only: downloads and installs Ollama (cancel with cancelChat(requestId)). */
  installOllama?(requestId: string, onProgress: (p: SetupProgress) => void): Promise<OllamaState>
  /** Desktop only: downloads a model (cancel with cancelChat(requestId)). */
  pullModel?(model: string, requestId: string, onProgress: (p: SetupProgress) => void): Promise<void>
  /** Desktop only: puts the native menu and prompts in the interface language. */
  setLanguage?(lang: 'en' | 'zh-Hant'): void
  /** Desktop only: asks for a JPG/PNG file and returns its path. */
  pickImage?(): Promise<string | null>
  /** Desktop only: the bytes of an image file on disk (for linked images). */
  readImageFile?(path: string): Promise<Uint8Array>
  /** Desktop only: files dropped on the window (paths, and the drop point in page pixels). */
  onFileDrop?(cb: (paths: string[], x: number, y: number) => void): () => void
  saveSettings(s: Settings): Promise<Settings>
  listModels(url?: string): Promise<string[]>
  chat(req: ChatRequest): Promise<string>
  cancelChat(requestId: string): Promise<void>
  onChatChunk(cb: (requestId: string, chunk: string) => void): () => void
  /** Loads a model ahead of time so the first request doesn't wait for it. */
  warmUp(model: string, numCtx?: number): Promise<void>
  /** Frees a model's memory right away. */
  unloadModel(model: string): Promise<void>
  /** Models Ollama has in memory, with how much of each is on the GPU. */
  loadedModels(): Promise<LoadedModel[]>

  openFile(): Promise<OpenResult | null>
  /** The file the app was launched with (double-clicked document), if any. */
  openInitialFile(): Promise<OpenResult | null>
  saveFile(path: string | null, data: AwdFile, saveAs?: boolean): Promise<string | null>
  exportFile(format: ExportFormat, doc: DocNode, html: string, suggestedName: string): Promise<string | null>
  saveRecovery(data: AwdFile, path: string | null): Promise<void>
  loadRecovery(): Promise<{ data: AwdFile; path: string | null; savedAt: string } | null>
  clearRecovery(): Promise<void>

  /** Called when the settings were changed elsewhere (another window, the web version, another device). */
  onSettingsChanged(cb: () => void): () => void

  setDirty(dirty: boolean, title: string): void
  onMenu(cb: (action: string) => void): () => void
}
