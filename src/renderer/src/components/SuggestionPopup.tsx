import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { forDisplay } from '../editor/changes'
import { t } from '../i18n'

export interface PopupView {
  /** Viewport coordinates of the text the popup belongs to. */
  x: number
  y: number
  /** Top of the text line, used to flip the popup above when there's no room below. */
  top: number
  title: string
  tone: 'grammar' | 'style' | 'improve'
  original: string
  suggestion?: string
  reason?: string
  loading?: boolean
  error?: string
}

interface Props {
  view: PopupView
  onAccept?: () => void
  onReject: () => void
  onIgnore?: () => void
  onRetry?: () => void
}

export function SuggestionPopup({ view, onAccept, onReject, onIgnore, onRetry }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: view.x, top: view.y + 6 })

  // Keep the popup inside the window: shift left if needed, flip above the text if needed.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(8, Math.min(view.x, window.innerWidth - w - 8))
    let top = view.y + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, view.top - h - 6)
    setPos({ left, top })
  }, [view])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onReject()
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onAccept && !view.loading && !view.error) {
        e.preventDefault()
        onAccept()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAccept, onReject, view])

  return (
    <div ref={ref} className={`popup popup-${view.tone}`} style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="popup-title">{view.title}</div>
      {view.loading ? (
        <div className="popup-loading">
          <span className="spinner" /> {t('Thinking…')}
        </div>
      ) : view.error ? (
        <div className="popup-error">{view.error}</div>
      ) : (
        <>
          <div className="diff">
            <div className="before">{forDisplay(view.original)}</div>
            <div className="arrow">↓</div>
            <div className="after">{forDisplay(view.suggestion ?? '')}</div>
          </div>
          {view.reason && <div className="reason">{view.reason}</div>}
        </>
      )}
      <div className="popup-actions">
        {onAccept && (
          <button className="primary" disabled={view.loading || !!view.error} onClick={onAccept} title="Ctrl+Enter">
            {t('Accept')}
          </button>
        )}
        <button onClick={onReject} title="Esc">
          {view.loading ? t('Cancel') : t('Reject')}
        </button>
        {onRetry && !view.loading && <button onClick={onRetry}>{t('Try again')}</button>}
        {onIgnore && (
          <button className="subtle" onClick={onIgnore} title={t('Never suggest a change for this text again in this document')}>
            {t('Ignore always')}
          </button>
        )}
      </div>
    </div>
  )
}
