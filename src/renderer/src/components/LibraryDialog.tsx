import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryItem } from '../../../shared/types'
import { t } from '../i18n'

interface Props {
  mode: 'open' | 'save'
  currentId: string | null
  currentName: string
  onOpen: (item: LibraryItem) => Promise<void>
  /** Saves the current document under `name`; `overwrite` replaces an existing document. */
  onSave: (name: string, overwrite: boolean) => Promise<void>
  onImport: (file: File) => Promise<void>
  /** A document was renamed (so the open document's name can follow). */
  onRenamed: (oldId: string, item: LibraryItem) => void
  onDeleted: (id: string) => void
  onClose: () => void
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function LibraryDialog(p: Props) {
  const library = window.api.library!
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [name, setName] = useState(p.currentName === 'Untitled' ? '' : p.currentName)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const reload = async () => {
    try {
      setItems(await library.list())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setItems([])
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const shown = useMemo(
    () => (items ?? []).filter((i) => i.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [items, filter]
  )

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const rename = (item: LibraryItem) => {
    const newName = window.prompt(t('New name for the document:'), item.name)
    if (!newName || newName.trim() === item.name) return
    void run(async () => {
      const updated = await library.rename(item.id, newName)
      p.onRenamed(item.id, updated)
      await reload()
    })
  }

  const remove = (item: LibraryItem) => {
    if (!window.confirm(t('Delete “{name}”? This cannot be undone.', { name: item.name }))) return
    void run(async () => {
      await library.remove(item.id)
      p.onDeleted(item.id)
      await reload()
    })
  }

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const existing = items?.find((i) => i.name.toLowerCase() === trimmed.toLowerCase())
    const isCurrent = existing && existing.id === p.currentId
    if (existing && !isCurrent && !window.confirm(t('“{name}” already exists. Replace it?', { name: existing.name }))) return
    void run(() => p.onSave(trimmed, !!existing))
  }

  return (
    <div className="modal-backdrop" onMouseDown={p.onClose}>
      <div className="modal wide library" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{p.mode === 'open' ? t('Open document') : t('Save document')}</h2>

        {p.mode === 'save' && (
          <form
            className="row save-row"
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <input autoFocus placeholder={t('Document name')} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="primary" disabled={busy || !name.trim()}>
              {t('Save')}
            </button>
          </form>
        )}

        <div className="row">
          <input placeholder={t('Search documents…')} value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus={p.mode === 'open'} />
        </div>

        <ul className="library-list">
          {items === null && <li className="muted">{t('Loading…')}</li>}
          {items !== null && shown.length === 0 && (
            <li className="muted">{items.length ? t('No documents match.') : t('No saved documents yet.')}</li>
          )}
          {shown.map((item) => (
            <li
              key={item.id}
              className={item.id === p.currentId ? 'current' : ''}
              onClick={() => (p.mode === 'save' ? setName(item.name) : undefined)}
              onDoubleClick={() => p.mode === 'open' && void run(() => p.onOpen(item))}
            >
              <div className="doc-name">
                {item.name}
                {item.id === p.currentId && <span className="tag">{t('open now')}</span>}
              </div>
              <span className="muted">{new Date(item.updatedAt).toLocaleString()}</span>
              <span className="muted size">{formatSize(item.size)}</span>
              <span className="doc-actions">
                {p.mode === 'open' && (
                  <button className="primary" disabled={busy} onClick={() => void run(() => p.onOpen(item))}>
                    {t('Open')}
                  </button>
                )}
                <button disabled={busy} onClick={(e) => (e.stopPropagation(), rename(item))}>
                  {t('Rename')}
                </button>
                <button className="danger" disabled={busy} onClick={(e) => (e.stopPropagation(), remove(item))}>
                  {t('Delete')}
                </button>
              </span>
            </li>
          ))}
        </ul>

        {error && <p className="bad">{error}</p>}

        <div className="modal-actions">
          {p.mode === 'open' && (
            <>
              <button title={t('Open a .docx, .md, .txt or .awd file from this device')} onClick={() => fileInput.current?.click()} disabled={busy}>
                {t('Import file from this device…')}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".awd,.docx,.md,.markdown,.txt"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void run(() => p.onImport(file))
                }}
              />
            </>
          )}
          <span className="spacer" />
          <button onClick={p.onClose}>{t('Cancel')}</button>
        </div>
      </div>
    </div>
  )
}
