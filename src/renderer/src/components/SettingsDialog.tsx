import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'
import { cleanError } from '../ai/liveChecker'
import { StylesDialog } from './StylesDialog'
import type { AccessInfo } from '../../../shared/types'
import { logoutRequest } from '../webApi'
import { t } from '../i18n'

/** Web version: addresses for other devices, and the network password. */
function NetworkAccess() {
  const [info, setInfo] = useState<AccessInfo | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    window.api.access!.info().then(setInfo).catch(() => {})
  }, [])

  const save = async () => {
    if (pw !== pw2) return setMsg({ ok: false, text: t('The two passwords are different.') })
    try {
      await window.api.access!.setPassword(pw)
      setPw('')
      setPw2('')
      setMsg({ ok: true, text: t('Password saved. Other devices can now log in with it.') })
      setInfo(await window.api.access!.info())
    } catch (err) {
      setMsg({ ok: false, text: cleanError(err instanceof Error ? err.message : String(err)) })
    }
  }

  if (!info) return null
  return (
    <div className="field network">
      <span>{t('Network access')}</span>
      {info.urls.length > 0 ? (
        <small>
          {t('Other devices on your network can open:')}{' '}
          {info.urls.map((u) => (
            <code key={u}>{u}</code>
          ))}
        </small>
      ) : (
        <small className="muted">{t("This PC isn't connected to a network.")}</small>
      )}
      {info.isLocal ? (
        <>
          <small className={info.passwordSet ? 'ok' : 'bad'}>
            {info.passwordSet ? t('A password is set.') : t('No password yet. Other devices can’t log in until you set one.')}
          </small>
          <div className="row">
            <input type="password" autoComplete="new-password" placeholder={info.passwordSet ? t('New password') : t('Password')} value={pw} onChange={(e) => setPw(e.target.value)} />
            <input type="password" autoComplete="new-password" placeholder={t('Repeat password')} value={pw2} onChange={(e) => setPw2(e.target.value)} />
            <button disabled={pw.length < 6} onClick={save} title={t('At least 6 characters')}>
              {info.passwordSet ? t('Change') : t('Set password')}
            </button>
          </div>
        </>
      ) : (
        <div className="row">
          <small className="muted">{t("You're connected from another device. The password can only be changed on the PC running Assist Writer.")}</small>
          <button onClick={() => logoutRequest().then(() => window.location.reload())}>{t('Log out')}</button>
        </div>
      )}
      {msg && <small className={msg.ok ? 'ok' : 'bad'}>{msg.text}</small>}
    </div>
  )
}

interface Props {
  /** The current settings, kept up to date while the dialog is open. */
  settings: Settings
  onSave: (s: Settings) => void
  /** Writing style changes apply immediately (toolbar, Live check, other windows), without Save. */
  onStyleChange: (id: string | null) => void
  onSaveStyles: (styles: Settings['styles']) => void
  /** Desktop: opens the Setup window (install Ollama, download models). */
  onSetup?: () => void
  onClose: () => void
}

export function SettingsDialog({ settings, onSave, onStyleChange, onSaveStyles, onSetup, onClose }: Props) {
  const [s, setS] = useState(settings)
  const [models, setModels] = useState<string[]>([])
  const [conn, setConn] = useState<{ ok: boolean; text: string } | null>(null)
  const [editStyles, setEditStyles] = useState(false)

  const test = async (url = s.ollamaUrl) => {
    setConn({ ok: true, text: t('Connecting…') })
    try {
      const list = await window.api.listModels(url)
      setModels(list)
      setConn({ ok: true, text: t('Connected. {n} model(s) installed.', { n: list.length }) })
    } catch (err) {
      setModels([])
      setConn({ ok: false, text: cleanError(err instanceof Error ? err.message : String(err)) })
    }
  }

  useEffect(() => {
    void test(settings.ollamaUrl)
  }, [])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }))

  const modelSelect = (key: 'liveModel' | 'rewriteModel') => (
    <select value={s[key]} onChange={(e) => set(key, e.target.value)}>
      {!models.includes(s[key]) && <option value={s[key]}>{t('{model} (not installed)', { model: s[key] })}</option>}
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  )

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('Settings')}</h2>

        <label className="field">
          <span>{t('Ollama address')}</span>
          <div className="row">
            <input value={s.ollamaUrl} onChange={(e) => set('ollamaUrl', e.target.value)} />
            <button onClick={() => test()}>{t('Test connection')}</button>
          </div>
          {conn && <small className={conn.ok ? 'ok' : 'bad'}>{conn.text}</small>}
          {onSetup && (
            <div className="row">
              <button onClick={onSetup}>{t('Set up Ollama and models…')}</button>
              <small className="muted">{t('Install Ollama, download models, check graphics memory.')}</small>
            </div>
          )}
        </label>

        <label className="field">
          <span>{t('Live checking model')}</span>
          {modelSelect('liveModel')}
          <small className="muted">{t('Used while you type and for “Improve”. A small, fast model works best.')}</small>
        </label>

        <label className="field">
          <span>{t('Whole-document rewrite model')}</span>
          {modelSelect('rewriteModel')}
          <small className="muted">{t('Used by “Rewrite doc”. A larger model gives better results but is slower.')}</small>
        </label>

        <label className="field">
          <span>{t('Writing style')}</span>
          <div className="row">
            <select value={settings.activeStyleId ?? ''} onChange={(e) => onStyleChange(e.target.value || null)}>
              <option value="">{t('None (general improvements)')}</option>
              {settings.styles.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
            </select>
            <button onClick={() => setEditStyles(true)}>{t('Manage styles…')}</button>
          </div>
          <small className="muted">
            {t('Applies right away to Live check, Improve and Rewrite doc, and to every open window. {n} styles.', { n: settings.styles.length })}
          </small>
        </label>

        <label className="field checkbox">
          <input type="checkbox" checked={s.liveCheck} onChange={(e) => set('liveCheck', e.target.checked)} />
          <span>{t('Check grammar and style automatically while I type')}</span>
        </label>

        <label className="field">
          <span>{t('Wait after typing before checking: {s} s', { s: (s.debounceMs / 1000).toFixed(1) })}</span>
          <input
            type="range"
            min={500}
            max={5000}
            step={250}
            value={s.debounceMs}
            onChange={(e) => set('debounceMs', Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>{t('Autosave recovery copy every')}</span>
          <select value={s.autosaveSec} onChange={(e) => set('autosaveSec', Number(e.target.value))}>
            {[15, 30, 60, 120, 300].map((n) => (
              <option key={n} value={n}>
                {t('{n} seconds', { n })}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t('Inserted image files')}</span>
          <select value={s.imageStorage} disabled={!window.api.pickImage} onChange={(e) => set('imageStorage', e.target.value as Settings['imageStorage'])}>
            <option value="embed">{t('Embed in the document (default)')}</option>
            <option value="link">{t('Link to the file on disk')}</option>
          </select>
          <small className="muted">
            {window.api.pickImage
              ? t('Embed: the .awd file carries a copy of each image, so it opens anywhere, but it grows by the image size. Link: the .awd only stores the path, so it stays small, but the image disappears if the file is moved or the document is opened on another computer. Exports (PDF, Word…) always include the images. Pasted images are always embedded.')
              : t('The web version always embeds images in the document.')}
          </small>
        </label>

        {window.api.access && <NetworkAccess />}

        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          {/* Styles were already applied as they changed; keep the current ones, not the copy from when the dialog opened. */}
          <button className="primary" onClick={() => onSave({ ...s, styles: settings.styles, activeStyleId: settings.activeStyleId })}>
            {t('Save')}
          </button>
        </div>
      </div>
      {editStyles && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <StylesDialog
            styles={settings.styles}
            onClose={() => setEditStyles(false)}
            onSave={(styles) => {
              onSaveStyles(styles) // applied everywhere right away
              setEditStyles(false)
            }}
          />
        </div>
      )}
    </div>
  )
}
