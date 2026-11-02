import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { t } from '../i18n'

/** A fixed zoom (1 = 100%), or fit the page's width / the whole page into the window. */
export type ZoomMode = number | 'width' | 'page'

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const MIN = ZOOM_STEPS[0]
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/** Page size in CSS pixels (Letter at 96 dpi), and the scroller's padding around it. */
const PAGE_W = 816
const PAGE_H = 1056
const PAD_X = 32
const PAD_Y = 56

const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z))

/** The last zoom is remembered on this computer (100% the first time). */
const ZOOM_KEY = 'assistWriter.zoom'
export function parseZoom(v: string | null): ZoomMode {
  if (v === 'width' || v === 'page') return v
  const n = Number(v)
  return v && Number.isFinite(n) && n > 0 ? clamp(n) : 1
}
function loadZoom(): ZoomMode {
  try {
    return parseZoom(localStorage.getItem(ZOOM_KEY))
  } catch {
    return 1
  }
}
function storeZoom(mode: ZoomMode) {
  try {
    localStorage.setItem(ZOOM_KEY, String(mode))
  } catch {
    // Storage unavailable: the zoom is kept until the app closes.
  }
}

/** The zoom that fits the page's width, or the whole page, into the scroller. */
export function fitZoom(mode: 'width' | 'page', width: number, height: number): number {
  const byWidth = (width - PAD_X) / PAGE_W
  const z = mode === 'width' ? byWidth : Math.min(byWidth, (height - PAD_Y) / PAGE_H)
  return clamp(Math.round(z * 100) / 100)
}

/** The next zoom step up or down from `z`. */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 0.001) ?? MAX
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? MIN
}

/**
 * View zoom for the page: applied as CSS zoom (so the layout, wrapping and clicks stay right),
 * with Ctrl + mouse wheel and Ctrl +, Ctrl −, Ctrl 0 shortcuts. Zoom doesn't change the document.
 * `ready`: the scroller is on screen (the app renders nothing until the editor exists).
 */
export function useZoom(scroller: RefObject<HTMLDivElement | null>, ready: boolean) {
  const [mode, setMode] = useState<ZoomMode>(loadZoom)
  useEffect(() => storeZoom(mode), [mode])
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [scroller, ready])

  const zoom = typeof mode === 'number' ? mode : size.width ? fitZoom(mode, size.width, size.height) : 1

  // Apply it, keeping the same part of the document in view.
  const [applied, setApplied] = useState(1)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || zoom === applied) return
    const top = el.scrollTop
    el.style.setProperty('--zoom', String(zoom))
    el.scrollTop = (top * zoom) / applied
    setApplied(zoom)
  }, [zoom, applied, scroller, ready])

  const zoomBy = useCallback((dir: 1 | -1) => setMode(stepZoom(zoom, dir)), [zoom])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1 : -1)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key === '=' || e.key === '+') zoomBy(1)
      else if (e.key === '-' || e.key === '_') zoomBy(-1)
      else if (e.key === '0') setMode(1)
      else return
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [scroller, zoomBy, ready])

  return { mode, zoom, setMode, zoomBy }
}

interface Props {
  mode: ZoomMode
  zoom: number
  onMode: (m: ZoomMode) => void
  onStep: (dir: 1 | -1) => void
}

/** Toolbar zoom: the current level, − / + buttons and a menu with fixed sizes, page width and whole page. */
export function ZoomControl({ mode, zoom, onMode, onStep }: Props) {
  const pct = `${Math.round(zoom * 100)}%`
  const value = typeof mode === 'number' ? String(mode) : mode
  return (
    <span className="zoom-control">
      <button title={t('Zoom out (Ctrl −)')} onClick={() => onStep(-1)} disabled={zoom <= MIN}>
        −
      </button>
      <select
        title={t('View zoom (Ctrl + mouse wheel). Ctrl 0 goes back to 100%.')}
        value={value}
        onChange={(e) => onMode(e.target.value === 'width' || e.target.value === 'page' ? e.target.value : Number(e.target.value))}
      >
        {typeof mode === 'number' && !ZOOM_STEPS.includes(mode) && <option value={value}>{pct}</option>}
        {ZOOM_STEPS.map((z) => (
          <option key={z} value={String(z)}>
            {Math.round(z * 100)}%
          </option>
        ))}
        <option value="width">{t('Page width')}{mode === 'width' ? ` (${pct})` : ''}</option>
        <option value="page">{t('Whole page')}{mode === 'page' ? ` (${pct})` : ''}</option>
      </select>
      <button title={t('Zoom in (Ctrl +)')} onClick={() => onStep(1)} disabled={zoom >= MAX}>
        +
      </button>
    </span>
  )
}
