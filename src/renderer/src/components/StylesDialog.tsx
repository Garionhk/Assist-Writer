import { useState } from 'react'
import { DEFAULT_STYLES, type WritingStyle } from '../../../shared/styles'
import { t } from '../i18n'

interface Props {
  styles: WritingStyle[]
  onSave: (styles: WritingStyle[]) => void
  onClose: () => void
}

const newId = (): string => `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function StylesDialog({ styles: initial, onSave, onClose }: Props) {
  const [styles, setStyles] = useState<WritingStyle[]>(initial)
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null)
  const selected = styles.find((s) => s.id === selectedId) ?? null
  const defaultOf = (s: WritingStyle) => DEFAULT_STYLES.find((d) => d.id === s.id)

  const update = (patch: Partial<WritingStyle>) =>
    setStyles((list) => list.map((s) => (s.id === selectedId ? { ...s, ...patch } : s)))

  const add = (base?: WritingStyle) => {
    const style: WritingStyle = {
      id: newId(),
      name: base ? t('{name} (copy)', { name: base.name }) : t('New style'),
      prompt: base?.prompt ?? t('Describe the target style: audience, tone, vocabulary, sentence length and structure…')
    }
    setStyles((list) => [...list, style])
    setSelectedId(style.id)
  }

  const remove = () => {
    if (!selected || !window.confirm(t('Delete the style “{name}”?', { name: selected.name }))) return
    const i = styles.findIndex((s) => s.id === selected.id)
    const rest = styles.filter((s) => s.id !== selected.id)
    setStyles(rest)
    setSelectedId(rest[Math.min(i, rest.length - 1)]?.id ?? null)
  }

  const move = (dir: -1 | 1) => {
    const i = styles.findIndex((s) => s.id === selectedId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= styles.length) return
    const list = [...styles]
    ;[list[i], list[j]] = [list[j], list[i]]
    setStyles(list)
  }

  /** Puts back built-in styles that were deleted or edited; custom styles are kept. */
  const restoreDefaults = () => {
    if (!window.confirm(t('Restore all built-in styles to their original text? Your own styles are kept.'))) return
    const custom = styles.filter((s) => !defaultOf(s))
    setStyles([...DEFAULT_STYLES, ...custom])
  }

  const valid = styles.every((s) => s.name.trim() && s.prompt.trim())

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide styles-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('Writing styles')}</h2>
        <p className="muted">
          {t('A style tells the AI how your writing should sound. It guides the style suggestions, “Improve” and “Rewrite doc”. Grammar fixes always apply.')}
        </p>
        <div className="styles-body">
          <div className="styles-list">
            <ul>
              {styles.map((s) => (
                <li key={s.id} className={s.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(s.id)}>
                  {s.name || <em className="muted">{t('(no name)')}</em>}
                  {!defaultOf(s) && <span className="tag">{t('custom')}</span>}
                </li>
              ))}
            </ul>
            <div className="row wrap">
              <button onClick={() => add()}>{t('+ New')}</button>
              <button disabled={!selected} onClick={() => selected && add(selected)}>
                {t('Duplicate')}
              </button>
              <button disabled={!selected} onClick={() => move(-1)} title={t('Move up')}>
                ↑
              </button>
              <button disabled={!selected} onClick={() => move(1)} title={t('Move down')}>
                ↓
              </button>
            </div>
          </div>

          <div className="styles-edit">
            {selected ? (
              <>
                <label className="field">
                  <span>{t('Name')}</span>
                  <input value={selected.name} onChange={(e) => update({ name: e.target.value })} />
                </label>
                <label className="field grow">
                  <span>{t('Prompt (instructions for the AI)')}</span>
                  <textarea value={selected.prompt} onChange={(e) => update({ prompt: e.target.value })} />
                  <small className="muted">
                    {t('Tip: describe the audience, tone, vocabulary and sentence style. You can also say how it should apply to Chinese text.')}
                  </small>
                </label>
                <div className="row">
                  {defaultOf(selected) && defaultOf(selected)!.prompt !== selected.prompt && (
                    <button onClick={() => update({ prompt: defaultOf(selected)!.prompt, name: defaultOf(selected)!.name })}>
                      {t('Reset this style')}
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="danger" onClick={remove}>
                    {t('Delete style')}
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">{t('No styles. Click “+ New” to add one.')}</p>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={restoreDefaults} className="left">
            {t('Restore built-in styles')}
          </button>
          <span className="spacer" />
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={!valid} title={valid ? '' : t('Every style needs a name and a prompt')} onClick={() => onSave(styles)}>
            {t('Save styles')}
          </button>
        </div>
      </div>
    </div>
  )
}
