import type { HistoryEntry } from '../../../shared/types'
import { forDisplay } from '../editor/changes'
import { t } from '../i18n'

const KIND_LABEL: Record<HistoryEntry['kind'], () => string> = {
  grammar: () => t('Grammar'),
  style: () => t('Style'),
  improve: () => t('Improve'),
  rewrite: () => t('Rewrite')
}

interface Props {
  history: HistoryEntry[]
  /** Change ids whose text is still in the document. */
  presentIds: Set<string>
  showMarks: boolean
  onToggleMarks: () => void
  onGoTo: (e: HistoryEntry) => void
  onUndo: (e: HistoryEntry) => void
  onClose: () => void
}

function shorten(s: string, n = 160): string {
  const text = forDisplay(s)
  return text.length > n ? text.slice(0, n) + '…' : text
}

export function HistoryPanel({ history, presentIds, showMarks, onToggleMarks, onGoTo, onUndo, onClose }: Props) {
  const entries = [...history].reverse()
  return (
    <aside className="history">
      <div className="history-head">
        <strong>{t('Change history')}</strong>
        <button className="subtle" onClick={onClose} title={t('Close')}>
          ✕
        </button>
      </div>
      <label className="history-toggle">
        <input type="checkbox" checked={showMarks} onChange={onToggleMarks} /> {t('Highlight AI changes in the text')}
      </label>
      {entries.length === 0 && <p className="muted">{t('Accepted AI changes will appear here. You can undo any one of them later.')}</p>}
      <ul>
        {entries.map((e) => {
          const present = presentIds.has(e.id)
          const status = e.undone ? t('Undone') : present ? null : t('Not in document')
          return (
            <li key={e.id} className={e.undone || !present ? 'inactive' : ''}>
              <div className="entry-meta">
                <span className={`badge badge-${e.kind}`}>{KIND_LABEL[e.kind]()}</span>
                <span className="muted">{new Date(e.time).toLocaleString()}</span>
              </div>
              <div className="entry-diff" onClick={() => present && onGoTo(e)} title={present ? t('Show in document') : ''}>
                <span className="before">{shorten(e.before)}</span>
                <span className="arrow"> → </span>
                <span className="after">{shorten(e.after)}</span>
              </div>
              {e.reason && <div className="entry-reason">{shorten(e.reason, 200)}</div>}
              <div className="entry-actions">
                {status ? (
                  <span className="muted">{status}</span>
                ) : (
                  <>
                    <button onClick={() => onGoTo(e)}>{t('Show')}</button>
                    <button onClick={() => onUndo(e)}>{t('Undo this change')}</button>
                  </>
                )}
                <span className="muted model">{e.model}</span>
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
