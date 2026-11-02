import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { setLinkLoader } from './editor/image'
import type { Api, LoadedModel, OllamaState, OpenResult, Settings, SetupProgress, SetupStatus } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { exportBytes, importBytes } from './fileFormats'

/** `window.api` for the desktop app: calls the Rust commands in src-tauri/src/main.rs. */

/** Saved settings on top of the built-in defaults (models, the 10 writing styles…). */
export const withDefaults = (saved: Partial<Settings> | null | undefined): Settings => ({ ...DEFAULT_SETTINGS, ...(saved ?? {}) })

const chunkListeners = new Set<(id: string, chunk: string) => void>()

const readBytes = async (path: string) => new Uint8Array(await invoke<ArrayBuffer>('read_file', { path }))

async function openPath(path: string | null): Promise<OpenResult | null> {
  if (!path) return null
  const bytes = await readBytes(path)
  return importBytes(path, bytes, path)
}

/** A linked image file as a data URL, for showing and exporting it. */
async function imageDataUrl(path: string): Promise<string> {
  const bytes = await readBytes(path)
  const type = /.png$/i.test(path) ? 'image/png' : 'image/jpeg'
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(bin)}`
}

export function createTauriApi(): Api {
  setLinkLoader(imageDataUrl)
  return {
    mode: 'desktop',

    getSettings: async () => withDefaults(await invoke<Partial<Settings>>('get_settings')),
    saveSettings: async (s) => withDefaults(await invoke<Partial<Settings>>('save_settings', { values: s })),
    listModels: (url) => invoke('list_models', { url: url ?? null }),

    chat(req) {
      const onChunk = new Channel<string>()
      onChunk.onmessage = (text) => chunkListeners.forEach((cb) => cb(req.requestId, text))
      return invoke<string>('chat', { req, onChunk })
    },
    cancelChat: (id) => invoke('cancel_chat', { requestId: id }),
    onChatChunk(cb) {
      chunkListeners.add(cb)
      return () => chunkListeners.delete(cb)
    },
    warmUp: (model, numCtx) => invoke('warm_up', { model, numCtx: numCtx ?? null }),
    unloadModel: (model) => invoke('unload_model', { model }),
    loadedModels: () => invoke<LoadedModel[]>('loaded_models'),

    pickImage: () => invoke<string | null>('pick_image'),
    ensureOllama: () => invoke<OllamaState>('ensure_ollama'),
    setupStatus: () => invoke<SetupStatus>('setup_status'),
    installOllama(requestId, onProgress) {
      const ch = new Channel<SetupProgress>()
      ch.onmessage = onProgress
      return invoke<OllamaState>('install_ollama', { requestId, onProgress: ch })
    },
    pullModel(model, requestId, onProgress) {
      const ch = new Channel<SetupProgress>()
      ch.onmessage = onProgress
      return invoke('pull_model', { model, requestId, onProgress: ch })
    },
    setLanguage: (lang) => void invoke('set_language', { lang }).catch(() => {}),
    readImageFile: readBytes,
    onFileDrop(cb) {
      // The desktop window takes file drops itself (the page gets no files), with paths.
      const off = getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type !== 'drop') return
        const scale = window.devicePixelRatio || 1
        cb(e.payload.paths, e.payload.position.x / scale, e.payload.position.y / scale)
      })
      return () => void off.then((fn) => fn())
    },

    openFile: async () => openPath(await invoke<string | null>('pick_open_file')),
    openInitialFile: async () => openPath(await invoke<string | null>('initial_file')),
    saveFile: (path, data, saveAs) => invoke('save_file', { path, data, saveAs: !!saveAs }),
    async exportFile(format, doc, html, name) {
      // DOCX/RTF/MD/TXT are produced here; PDF is printed from the HTML by the Rust side.
      const bytes = format === 'pdf' ? null : Array.from(await exportBytes(format, doc))
      return invoke<string | null>('export_file', { format, name, bytes, html: format === 'pdf' ? html : null })
    },

    saveRecovery: (data, path) => invoke('save_recovery', { data, path }),
    loadRecovery: () => invoke('load_recovery'),
    clearRecovery: () => invoke('clear_recovery'),

    onSettingsChanged(cb) {
      const off = listen('settings-changed', () => cb())
      return () => void off.then((fn) => fn())
    },

    setDirty: (dirty, title) => void invoke('set_dirty', { dirty, title }),
    onMenu(cb) {
      const off = listen<string>('menu', (e) => cb(e.payload))
      return () => void off.then((fn) => fn())
    }
  }
}
