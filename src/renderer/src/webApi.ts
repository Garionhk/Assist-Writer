import type { AccessInfo, Api, AwdFile, LibraryItem, Settings } from '../../shared/types'
import { exportBytes, importBytes } from './fileFormats'
import { withDefaults } from './tauriApi'

/** `window.api` for the browser version: talks to the Assist Writer server over HTTP. */

class ApiError extends Error {}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal
  })
  if (res.status === 401 && path !== '/api/login') {
    // Session expired (e.g. the server restarted): back to the login screen.
    window.location.reload()
    throw new ApiError('Please log in again.')
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
  if (!res.ok) throw new ApiError(data?.error ?? `Server error (${res.status})`)
  return data as T
}

export interface Session {
  authenticated: boolean
  isLocal: boolean
  passwordSet: boolean
}

export const getSession = (): Promise<Session> => request('GET', '/api/session')
export const loginRequest = (password: string): Promise<void> => request('POST', '/api/login', { password })
export const logoutRequest = (): Promise<void> => request('POST', '/api/logout', {})

const RECOVERY_KEY = 'assist-writer-recovery'

/** Keyboard shortcuts that the desktop app gets from its menu. */
const SHORTCUTS: { key: string; ctrl: boolean; shift?: boolean; action: string }[] = [
  { key: 's', ctrl: true, shift: true, action: 'saveAs' },
  { key: 's', ctrl: true, action: 'save' },
  { key: 'o', ctrl: true, action: 'open' },
  { key: 'h', ctrl: true, action: 'history' },
  { key: ',', ctrl: true, action: 'settings' }
  // Ctrl+N / Ctrl+Shift+N belong to the browser, so "New" is toolbar-only on the web.
]

export function createWebApi(): Api {
  const chunkListeners = new Set<(id: string, chunk: string) => void>()
  const controllers = new Map<string, AbortController>()
  let dirty = false

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault()
  })

  return {
    mode: 'web',

    getSettings: async () => withDefaults(await request<Partial<Settings>>('GET', '/api/settings')),
    saveSettings: async (s: Settings) => withDefaults(await request<Partial<Settings>>('PUT', '/api/settings', s)),
    listModels: (url) => request('GET', `/api/models${url ? `?url=${encodeURIComponent(url)}` : ''}`),

    async chat(req) {
      const controller = new AbortController()
      controllers.set(req.requestId, controller)
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          credentials: 'same-origin',
          signal: controller.signal
        })
        if (res.status === 401) {
          window.location.reload()
          throw new ApiError('Please log in again.')
        }
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => null)
          throw new ApiError(data?.error ?? `Server error (${res.status})`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            if (!line.trim()) continue
            const msg = JSON.parse(line) as { chunk?: string; result?: string; error?: string }
            if (msg.chunk) chunkListeners.forEach((cb) => cb(req.requestId, msg.chunk!))
            if (msg.error) throw new ApiError(msg.error)
            if (msg.result !== undefined) return msg.result
          }
        }
        throw new ApiError('The connection to the server was lost.')
      } catch (err) {
        if (controller.signal.aborted) throw new ApiError('cancelled')
        throw err
      } finally {
        controllers.delete(req.requestId)
      }
    },
    async cancelChat(id) {
      controllers.get(id)?.abort()
      await request('POST', '/api/chat/cancel', { requestId: id }).catch(() => {})
    },
    onChatChunk(cb) {
      chunkListeners.add(cb)
      return () => chunkListeners.delete(cb)
    },
    warmUp: (model, numCtx) => request('POST', '/api/models/warm', { model, numCtx }),
    unloadModel: (model) => request('POST', '/api/models/unload', { model }),
    loadedModels: () => request('GET', '/api/models/loaded'),

    // The web version uses the documents library instead of file dialogs.
    openFile: async () => null,
    openInitialFile: async () => null,
    saveFile: async () => null,

    async exportFile(format, doc, html, name) {
      // Word/RTF/Markdown/text are made right here; only PDF is printed by the server.
      let blob: Blob
      if (format === 'pdf') {
        const res = await fetch('/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format, html, name }),
          credentials: 'same-origin'
        })
        if (!res.ok) {
          const data = await res.json().catch(() => null)
          throw new ApiError(data?.error ?? `Export failed (${res.status})`)
        }
        blob = await res.blob()
      } else {
        blob = new Blob([(await exportBytes(format, doc)) as BlobPart])
      }
      const fileName = `${name}.${format}`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return `${fileName} (downloaded)`
    },

    // Recovery copies stay in this browser, so each device has its own.
    async saveRecovery(data, path) {
      try {
        localStorage.setItem(RECOVERY_KEY, JSON.stringify({ data, path, savedAt: new Date().toISOString() }))
      } catch {
        /* storage full or disabled */
      }
    },
    async loadRecovery() {
      try {
        const raw = localStorage.getItem(RECOVERY_KEY)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    },
    async clearRecovery() {
      try {
        localStorage.removeItem(RECOVERY_KEY)
      } catch {
        /* ignore */
      }
    },

    onSettingsChanged(cb) {
      // A live event stream from the server; the browser reconnects it automatically.
      const events = new EventSource('/api/events')
      events.addEventListener('settings', () => cb())
      return () => events.close()
    },

    setDirty(isDirty, title) {
      dirty = isDirty
      document.title = `${isDirty ? '● ' : ''}${title} — Assist Writer`
    },
    onMenu(cb) {
      const onKey = (e: KeyboardEvent) => {
        const ctrl = e.ctrlKey || e.metaKey
        const hit = SHORTCUTS.find((s) => s.key === e.key.toLowerCase() && s.ctrl === ctrl && !!s.shift === e.shiftKey)
        if (!hit) return
        e.preventDefault()
        cb(hit.action)
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    },

    library: {
      list: () => request<LibraryItem[]>('GET', '/api/library'),
      load: (id) => request<AwdFile>('GET', `/api/library/${encodeURIComponent(id)}`),
      save: (id, name, data, overwrite) => request<LibraryItem>('PUT', '/api/library', { id, name, data, overwrite }),
      rename: (id, name) => request<LibraryItem>('POST', `/api/library/${encodeURIComponent(id)}/rename`, { name }),
      remove: (id) => request<void>('DELETE', `/api/library/${encodeURIComponent(id)}`),
      // Converted in the browser; an imported .awd isn't in the library yet, so it has no id.
      importFile: async (file) => importBytes(file.name, new Uint8Array(await file.arrayBuffer()), null)
    },
    access: {
      info: () => request<AccessInfo>('GET', '/api/access'),
      setPassword: (password) => request<void>('POST', '/api/access/password', { password })
    }
  }
}
