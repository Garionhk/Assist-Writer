// Images with Word-style text wrapping. An image is an inline node in a paragraph. In line
// images sit in the text; every other wrap mode is anchored to its paragraph, like Word:
// the node is kept at the start of the paragraph so text wraps around it from the first line.
import { Node, mergeAttributes } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { onLanguageChange, t } from '../i18n'

export type WrapMode = 'inline' | 'square' | 'tight' | 'through' | 'topBottom' | 'behind' | 'front'
export type Side = 'left' | 'center' | 'right'
/** Where an in-line image sits on its text line. */
export type VAlign = 'top' | 'middle' | 'bottom'
/**
 * Where a wrapped or free-placed image sits beside its paragraph's text: level with the top of
 * the first line's letters, centred on the text, on the last line, or 'free' (the paragraph's
 * top for wrapped images, the Y offset for behind / in front of text).
 */
export type VPos = 'free' | VAlign

export interface ImageAttrs {
  /** Embedded image (data URL). Empty for a linked image. */
  src: string
  /** Path of a linked image file (desktop app), or empty for an embedded image. */
  link: string
  alt: string
  width: number
  height: number
  wrap: WrapMode
  side: Side
  /** In line: aligned with the top, middle or bottom of its text line. */
  valign: VAlign
  /** Every other mode except top-and-bottom: aligned with its paragraph's text, or free. */
  vpos: VPos
  /** Gap between the image and the text around it (px). */
  margin: number
  /** Offset from the anchor paragraph (px), for behind/in front of text. */
  x: number
  y: number
}

export const WRAP_MODES: { mode: WrapMode; label: string; title: string }[] = [
  { mode: 'inline', label: 'In line', title: 'In line with text: the image sits in the line like a large character' },
  { mode: 'square', label: 'Square', title: 'Square: text wraps around the image box' },
  { mode: 'tight', label: 'Tight', title: 'Tight: text follows the image outline (transparent PNG edges)' },
  { mode: 'through', label: 'Through', title: 'Through: like Tight, text flows into transparent areas of the image' },
  { mode: 'topBottom', label: 'Top & bottom', title: 'Top and bottom: the image on its own line, no text beside it' },
  { mode: 'behind', label: 'Behind', title: 'Behind text: place freely; text runs over the image' },
  { mode: 'front', label: 'In front', title: 'In front of text: place freely; the image covers the text' }
]

/** Images bigger than this are refused (the document keeps a copy of every embedded image). */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
/** Width of the page's text area (816 px page minus 2 × 84 px margins). */
export const PAGE_TEXT_WIDTH = 648
/** Default gap between a wrapped image and the text (≈ Word's 0.13"). */
export const DEFAULT_MARGIN = 12

const VALIGNS: VAlign[] = ['top', 'middle', 'bottom']

export const isAbsolute = (wrap: WrapMode) => wrap === 'behind' || wrap === 'front'
const isFloat = (wrap: WrapMode) => wrap === 'square' || wrap === 'tight' || wrap === 'through'
/** Every mode except "in line" is anchored to the paragraph (kept at its start). */
export const isAnchored = (wrap: WrapMode) => wrap !== 'inline'

export function isSupportedImageSrc(src: unknown): boolean {
  return typeof src === 'string' && /^data:image\/(png|jpe?g);base64,/i.test(src)
}

/**
 * Linked images: the file's contents as a data URL, read once per path (by the desktop app's
 * loader) and kept here, so the editor, PDF printing and exports all show the same image.
 */
let linkLoader: ((path: string) => Promise<string>) | null = null
const linked = new Map<string, string>()
const loadingLinks = new Map<string, Promise<string>>()
export function setLinkLoader(fn: (path: string) => Promise<string>) {
  linkLoader = fn
}
/** Remembers a linked file's contents (already read when it was inserted). */
export function rememberLink(path: string, url: string) {
  linked.set(path, url)
}
/** The data URL of a linked file ('' if it can't be read). */
export function loadLink(path: string): Promise<string> {
  const known = linked.get(path)
  if (known !== undefined) return Promise.resolve(known)
  let p = loadingLinks.get(path)
  if (!p) {
    p = (linkLoader ? linkLoader(path) : Promise.resolve(''))
      .catch(() => '')
      .then((url) => {
        linked.set(path, url)
        loadingLinks.delete(path)
        return url
      })
    loadingLinks.set(path, p)
  }
  return p
}

/** The URL to show for an image: its embedded data, or its linked file once it's loaded. */
export function displaySrc(a: Pick<ImageAttrs, 'src' | 'link'>): string {
  return a.link ? (linked.get(a.link) ?? '') : a.src
}

/** A copy of the document JSON with every linked image embedded (for exports). */
export async function embedLinkedImages<T>(json: T): Promise<T> {
  const walk = async (n: unknown): Promise<unknown> => {
    if (Array.isArray(n)) return Promise.all(n.map(walk))
    if (!n || typeof n !== 'object') return n
    const o = n as Record<string, unknown>
    const attrs = o.attrs as Record<string, unknown> | undefined
    const out: Record<string, unknown> = { ...o }
    if (o.type === 'image' && attrs?.link) out.attrs = { ...attrs, src: await loadLink(String(attrs.link)), link: '' }
    if (o.content) out.content = await walk(o.content)
    return out
  }
  return (await walk(json)) as T
}

const px = (n: number) => `${Math.round(n)}px`

/**
 * Tight/Through outlines: for each of up to 48 bands from top to bottom, the left and right edge
 * of the image's visible (non-transparent) part as fractions of its width ("0.12 0.88"), or "-"
 * for a fully transparent band; '' when the image has no transparent parts (then text wraps
 * around its box, as in Word). The layout code turns it into a polygon the text flows around.
 */
const outlines = new Map<string, string>()
const pending = new Map<string, Promise<string>>()
export function rememberOutline(src: string, outline: string) {
  outlines.set(src, outline)
}
export function imageOutline(src: string): Promise<string> {
  const known = outlines.get(src)
  if (known !== undefined) return Promise.resolve(known)
  let p = pending.get(src)
  if (!p) {
    p = new Promise<string>((resolve) => {
      const img = new window.Image()
      img.onload = () => {
        let outline = ''
        try {
          const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          let transparent = false
          for (let i = 3; i < data.length; i += 4) if (data[i] < 102) { transparent = true; break }
          if (transparent) {
            const w = canvas.width
            const bands = Math.min(48, canvas.height)
            const rows: string[] = []
            for (let b = 0; b < bands; b++) {
              let lo = w
              let hi = -1
              const y0 = Math.floor((b * canvas.height) / bands)
              const y1 = Math.max(y0 + 1, Math.floor(((b + 1) * canvas.height) / bands))
              for (let y = y0; y < y1; y++) {
                for (let x = 0; x < w; x++) {
                  if (data[(y * w + x) * 4 + 3] >= 102) {
                    if (x < lo) lo = x
                    if (x > hi) hi = x
                  }
                }
              }
              rows.push(hi < 0 ? '-' : `${+(lo / w).toFixed(3)} ${+((hi + 1) / w).toFixed(3)}`)
            }
            outline = rows.join(',')
          }
        } catch {
          outline = ''
        }
        resolve(outline)
      }
      img.onerror = () => resolve('')
      img.src = src
    }).then((o) => {
      outlines.set(src, o)
      pending.delete(src)
      return o
    })
    pending.set(src, p)
  }
  return p
}

/** CSS for an image in each wrap mode; the same in the editor and in printed/PDF output. */
export function imageStyle(a: ImageAttrs, src: string = displaySrc(a)): string {
  const size = `width:${px(a.width)};height:${px(a.height)};`
  const m = Math.max(0, a.margin ?? DEFAULT_MARGIN)
  switch (a.wrap) {
    case 'square':
    case 'tight':
    case 'through': {
      const side = a.side === 'right' ? 'right' : 'left'
      // The gap is on the text side and below the image.
      const margin = side === 'left' ? `margin:0 ${px(m)} ${px(m)} 0;` : `margin:0 0 ${px(m)} ${px(m)};`
      // Tight/Through: text follows the outline, flowing into transparent parts of a PNG. The
      // shape itself (a polygon from the outline) is set by alignImage, which also moves the
      // image down for Top / Middle / Bottom.
      const outline = a.wrap === 'square' || !src ? '' : outlines.get(src)
      const shape = outline ? `shape-margin:${px(m)};` : ''
      // z-index: the following (positioned) paragraphs extend under the float and would take its clicks.
      return `float:${side};${margin}${size}${shape}position:relative;z-index:1;`
    }
    case 'topBottom': {
      // The gap is above and below; left/centre/right alignment through the side margins.
      const left = a.side === 'left' ? '0' : 'auto'
      const right = a.side === 'right' ? '0' : 'auto'
      return `display:block;clear:both;margin:${px(m)} ${right} ${px(m)} ${left};${size}`
    }
    case 'behind':
    case 'front':
      return `position:absolute;left:${px(a.x)};top:${px(a.y)};z-index:${a.wrap === 'behind' ? -1 : 5};${size}`
    default:
      // In line: the gap on every side, like padding around a large character, and its place
      // on the text line.
      return `display:inline-block;vertical-align:${VALIGNS.includes(a.valign) ? a.valign : 'bottom'};margin:${px(m)};${size}`
  }
}

/**
 * Places an image against the letters of its text, after layout:
 * - In line: its top level with the top of the tallest letters on its line (Top), centred on
 *   them (Middle), or its bottom on the line they sit on (Bottom).
 * - Square / Tight / Through / Behind / In front, with Top / Middle / Bottom: its top level with
 *   the top of the paragraph's first line of letters, centred on the paragraph's text, or its
 *   bottom on the paragraph's last line. Wrapped images move down (never above their paragraph)
 *   with the text above them using the full width; free-placed ones get the matching Y.
 * - Tight / Through: the text follows a polygon made from the image's outline.
 * CSS's own vertical-align keywords use the line box and the font's ascent, which include
 * empty space above the letters, so everything is measured instead: the letters' real top comes
 * from the font (canvas text metrics). Self-contained (DOM only) so the PDF print page can run
 * the same code.
 */
export function alignImage(el: HTMLElement): void {
  const wrap = el.dataset.wrap || 'inline'
  const block = el.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, pre') || el.parentElement
  if (!block) return
  const zoom = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  const ctx = document.createElement('canvas').getContext('2d')

  /** The text's lines beside a band of the page (or the whole block): letter tops and baselines. */
  const measure = (bandTop: number, bandBottom: number) => {
    const lines: { base: number; ink: number; lineTop: number }[] = []
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent || ''
      if (!text.trim() || el.contains(n) || !n.parentElement) continue
      const cs = getComputedStyle(n.parentElement)
      let fontAscent = parseFloat(cs.fontSize) * 0.9
      let letterAscent = fontAscent * 0.75
      if (ctx) {
        ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily
        const m = ctx.measureText(text.trim().slice(0, 200))
        if (m.fontBoundingBoxAscent) fontAscent = m.fontBoundingBoxAscent
        if (m.actualBoundingBoxAscent) letterAscent = m.actualBoundingBoxAscent
      }
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects())) {
        if (r.height > 0 && r.bottom > bandTop && r.top < bandBottom) {
          const base = r.top + fontAscent * zoom
          // The top of the whole line box, line spacing included.
          const lh = parseFloat(cs.lineHeight) * zoom
          const lineTop = Number.isFinite(lh) ? r.top - Math.max(0, lh - r.height) / 2 : r.top
          lines.push({ base, ink: base - letterAscent * zoom, lineTop })
        }
      }
    }
    return lines
  }

  if (wrap === 'inline') {
    const valign = el.dataset.valign
    if (valign !== 'top' && valign !== 'middle' && valign !== 'bottom') return
    el.style.verticalAlign = '0px'
    const box = el.getBoundingClientRect()
    // Only the pieces of text on the image's own line overlap it (it sits on that line's baseline).
    const lines = measure(box.top, box.bottom)
    if (!lines.length) {
      el.style.verticalAlign = valign // no text beside it
      return
    }
    const inkTop = Math.min(...lines.map((l) => l.ink))
    const baseline = Math.max(...lines.map((l) => l.base))
    const shift = valign === 'top' ? box.top - inkTop : valign === 'middle' ? (box.top + box.bottom - inkTop - baseline) / 2 : box.bottom - baseline
    el.style.verticalAlign = Math.round((shift / zoom) * 10) / 10 + 'px'
    return
  }

  const floating = wrap === 'square' || wrap === 'tight' || wrap === 'through'
  const absolute = wrap === 'behind' || wrap === 'front'
  if (!floating && !absolute) return
  const vpos = el.dataset.vpos
  const aligned = vpos === 'top' || vpos === 'middle' || vpos === 'bottom'
  const width = parseFloat(el.style.width) || el.offsetWidth
  const height = parseFloat(el.style.height) || el.offsetHeight
  const margin = parseFloat(el.dataset.margin || '0') || 0
  const outline = el.dataset.outline || ''
  const left = getComputedStyle(el).cssFloat !== 'right'

  /** Where the image's top goes, in px below the paragraph's top (null: leave it). */
  const target = (): number | null => {
    if (!aligned) return null
    const b = block.getBoundingClientRect()
    const lines = measure(b.top, b.bottom)
    if (!lines.length) return null
    const firstBase = Math.min(...lines.map((l) => l.base))
    const firstTop = Math.min(...lines.filter((l) => l.base <= firstBase + 1).map((l) => l.ink))
    const lastBase = Math.max(...lines.map((l) => l.base))
    const h = height * zoom
    const y = vpos === 'top' ? firstTop - b.top : vpos === 'middle' ? (firstTop + lastBase) / 2 - h / 2 - b.top : lastBase - h - b.top
    return Math.round((y / zoom) * 10) / 10
  }

  if (absolute) {
    const y = target()
    if (y !== null) el.style.top = y + 'px'
    return
  }

  /** Moves a wrapped image down by y, with the text above it on the full width. */
  /**
   * Where the text has to start avoiding the image (px below the paragraph's top): the top of
   * the line the image's top falls on. The browser only wraps a line around a shape that
   * already covers the line's top, so the shape starts there rather than at the image.
   */
  const avoidFrom = (y: number) => {
    if (!y) return 0
    const b = block.getBoundingClientRect()
    const imageTop = b.top + y * zoom
    let from = 0
    for (const l of measure(b.top, b.bottom)) if (l.lineTop <= imageTop + 0.5) from = Math.max(from, (l.lineTop - b.top) / zoom)
    return Math.round(Math.min(y, Math.max(0, from)) * 10) / 10
  }

  const place = (y: number) => {
    el.style.marginTop = y ? y + 'px' : ''
    const from = avoidFrom(y)
    // The text follows the image's outline (Tight/Through) or its box, and not the space above it.
    if (outline && (wrap === 'tight' || wrap === 'through')) {
      const rows = outline.split(',')
      const x0 = left ? 0 : margin
      const right: string[] = []
      const back: string[] = []
      const r1 = (v: number) => Math.round(v * 10) / 10 + 'px'
      rows.forEach((row, i) => {
        const t = i === 0 ? from : y + (i * height) / rows.length
        const bt = y + ((i + 1) * height) / rows.length
        let lo: number
        let hi: number
        if (row === '-') lo = hi = left ? x0 : x0 + width
        else {
          const [a, c] = row.split(' ').map(Number)
          lo = x0 + a * width
          hi = x0 + c * width
        }
        right.push(r1(hi) + ' ' + r1(t), r1(hi) + ' ' + r1(bt))
        back.unshift(r1(lo) + ' ' + r1(bt), r1(lo) + ' ' + r1(t))
      })
      el.style.shapeOutside = 'polygon(' + right.concat(back).join(',') + ')'
    } else {
      el.style.shapeOutside = from ? 'inset(' + from + 'px 0 0 0)' : ''
    }
  }
  // Middle / Bottom depend on how the paragraph's text wraps around the image, which depends on
  // where it is: settle it in a few rounds.
  let y = Math.max(0, target() ?? 0)
  place(y)
  for (let round = 0; aligned && round < 3; round++) {
    const next = Math.max(0, target() ?? 0)
    if (Math.abs(next - y) < 1) break
    y = next
    place(y)
  }
}

/** Re-places every image in the editor after the next layout. */
function scheduleAlign(root: HTMLElement) {
  const r = root as HTMLElement & { awAlignQueued?: boolean }
  if (r.awAlignQueued) return
  r.awAlignQueued = true
  requestAnimationFrame(() => {
    r.awAlignQueued = false
    root.querySelectorAll<HTMLElement>('.aw-image').forEach(alignImage)
  })
}

const num = (v: string | null, d: number) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)

/**
 * Keeps anchored images (every mode except "in line") at the start of their paragraph, as Word
 * anchors them, so text wraps around them from the paragraph's first line.
 */
export function anchorAtParagraphStart(tr: Transaction, doc: PMNode, selected: PMNode | null): Transaction | null {
  const fixes: { pos: number; items: { node: PMNode; offset: number }[] }[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const items: { node: PMNode; offset: number }[] = []
    let leading = true
    let misplaced = false
    node.forEach((child, offset) => {
      if (child.type.name === 'image' && isAnchored(child.attrs.wrap)) {
        items.push({ node: child, offset })
        if (!leading) misplaced = true
      } else leading = false
    })
    if (misplaced) fixes.push({ pos, items })
    return false
  })
  if (!fixes.length) return null
  // From the end of the document backwards, so earlier positions stay valid.
  for (const { pos, items } of fixes.reverse()) {
    for (const { offset } of [...items].reverse()) tr.delete(pos + 1 + offset, pos + 2 + offset)
    tr.insert(pos + 1, items.map((i) => i.node))
  }
  if (selected) {
    tr.doc.descendants((n, p) => {
      if (n === selected) tr.setSelection(NodeSelection.create(tr.doc, p))
      return n !== selected
    })
  }
  return tr
}

export const Image = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: false, // moved with our own mouse dragging (see ImageView)
  selectable: true,

  addAttributes() {
    return {
      src: { default: '' },
      link: { default: '', parseHTML: (el) => el.getAttribute('data-link') || '' },
      alt: { default: '' },
      width: { default: 200, parseHTML: (el) => num(el.getAttribute('width'), (el as HTMLImageElement).naturalWidth || 200) },
      height: { default: 150, parseHTML: (el) => num(el.getAttribute('height'), (el as HTMLImageElement).naturalHeight || 150) },
      wrap: { default: 'inline', parseHTML: (el) => (WRAP_MODES.some((m) => m.mode === el.getAttribute('data-wrap')) ? el.getAttribute('data-wrap') : 'inline') },
      side: { default: 'left', parseHTML: (el) => el.getAttribute('data-side') || 'left' },
      vpos: { default: 'free', parseHTML: (el) => (['top', 'middle', 'bottom'].includes(el.getAttribute('data-vpos') ?? '') ? el.getAttribute('data-vpos') : 'free') },
      valign: { default: 'bottom', parseHTML: (el) => (VALIGNS as string[]).includes(el.getAttribute('data-valign') ?? '') ? el.getAttribute('data-valign') : 'bottom' },
      margin: { default: DEFAULT_MARGIN, parseHTML: (el) => num(el.getAttribute('data-margin'), DEFAULT_MARGIN) },
      x: { default: 0, parseHTML: (el) => num(el.getAttribute('data-x'), 0) },
      y: { default: 0, parseHTML: (el) => num(el.getAttribute('data-y'), 0) }
    }
  },

  parseHTML() {
    // Only embedded PNG/JPEG images or our own linked images: remote images are never loaded.
    return [
      {
        tag: 'img',
        getAttrs: (el) => {
          const e = el as HTMLElement
          return isSupportedImageSrc(e.getAttribute('src')) || e.getAttribute('data-link') ? null : false
        }
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs as ImageAttrs
    return [
      'img',
      mergeAttributes(
        { src: displaySrc(a), alt: a.alt, width: Math.round(a.width), height: Math.round(a.height) },
        a.link ? { 'data-link': a.link } : {},
        {
          'data-wrap': a.wrap,
          'data-side': a.side,
          'data-valign': a.valign ?? 'bottom',
          'data-vpos': a.vpos ?? 'free',
          // Tight/Through outline, used by the layout code to shape the text around the image.
          ...(a.wrap === 'tight' || a.wrap === 'through' ? { 'data-outline': outlines.get(displaySrc(a)) || '' } : {}),
          'data-margin': Math.round(a.margin ?? DEFAULT_MARGIN),
          'data-x': Math.round(a.x),
          'data-y': Math.round(a.y),
          style: imageStyle(a)
        },
        { class: HTMLAttributes.class }
      )
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('imageAnchors'),
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.docChanged)) return null
          const sel = state.selection
          const selected = sel instanceof NodeSelection && sel.node.type.name === 'image' ? sel.node : null
          return anchorAtParagraphStart(state.tr, state.doc, selected)
        },
        // In-line images follow the text on their line: re-align after every change, when the
        // page width changes (lines rewrap) and once fonts have loaded.
        view: (view) => {
          const root = view.dom as HTMLElement
          const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => scheduleAlign(root))
          ro?.observe(root)
          void document.fonts?.ready.then(() => scheduleAlign(root))
          scheduleAlign(root)
          return {
            update: () => scheduleAlign(root),
            destroy: () => ro?.disconnect()
          }
        }
      })
    ]
  },

  addNodeView() {
    return ({ node, getPos, editor }) => new ImageView(node, editor.view, getPos as () => number | undefined)
  }
})

/** Gap between an image and its toolbar (px). */
const BAR_GAP = 18
const BAR_KEY = 'assistWriter.imageBarOffset'
/** Where the user dragged the image toolbar, relative to the image (kept for next time). */
let barOffset: { dx: number; dy: number } | null = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(BAR_KEY) ?? 'null')
    return v && Number.isFinite(v.dx) && Number.isFinite(v.dy) ? v : null
  } catch {
    return null
  }
})()
function setBarOffset(v: { dx: number; dy: number } | null) {
  barOffset = v
  try {
    if (v) localStorage.setItem(BAR_KEY, JSON.stringify(v))
    else localStorage.removeItem(BAR_KEY)
  } catch {
    // Storage unavailable: the position is kept until the app closes.
  }
}

/** Editor view of an image: selection frame, resize handles, wrap toolbar and mouse dragging. */
class ImageView {
  dom: HTMLElement
  private img: HTMLImageElement
  private bar: HTMLElement
  private lockRatio = true

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined
  ) {
    this.dom = document.createElement('span')
    this.dom.className = 'aw-image'
    this.dom.contentEditable = 'false'
    this.dom.draggable = false
    this.img = document.createElement('img')
    this.img.draggable = false
    this.img.addEventListener('error', () => this.dom.classList.add('missing'))
    this.img.addEventListener('load', () => this.dom.classList.remove('missing'))
    this.dom.appendChild(this.img)
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('span')
      h.className = `aw-image-handle aw-image-handle-${corner}`
      h.dataset.corner = corner
      this.dom.appendChild(h)
    }
    // The wrap toolbar floats above everything (not inside the image), so it stays usable
    // even for an image behind the text. It is only in the page while the image is selected.
    this.bar = this.buildBar()
    this.offLanguage = onLanguageChange(() => {
      this.relabel()
      this.render()
    })
    this.dom.addEventListener('mousedown', (e) => this.onMouseDown(e))
    this.render()
  }

  private get attrs(): ImageAttrs {
    return this.node.attrs as ImageAttrs
  }

  private render() {
    const a = this.attrs
    const src = displaySrc(a)
    if (this.img.getAttribute('src') !== src) this.img.src = src
    this.img.alt = a.alt
    this.dom.title = a.link ? t('Linked image: {path}', { path: a.link }) : ''
    this.dom.classList.toggle('linked', !!a.link)
    if (!src) this.dom.classList.add('missing')
    if (a.link && !src) {
      void loadLink(a.link).then((url) => {
        if (url && this.node.attrs.link === a.link) this.render()
      })
    }
    const embed = this.bar.querySelector<HTMLButtonElement>('button[data-action="embed"]')!
    embed.hidden = !a.link
    // Absolute modes are positioned already; other modes need a positioned box for the handles.
    this.dom.style.cssText = imageStyle(a, src) + (isAbsolute(a.wrap) ? '' : 'position:relative;')
    if ((a.wrap === 'tight' || a.wrap === 'through') && src && !outlines.has(src)) {
      void imageOutline(src).then(() => {
        if (this.node.attrs.src === a.src && this.node.attrs.link === a.link) this.render()
      })
    }
    this.dom.dataset.wrap = a.wrap
    this.dom.dataset.valign = a.valign ?? 'bottom'
    this.dom.dataset.vpos = a.vpos ?? 'free'
    this.dom.dataset.margin = String(a.margin ?? DEFAULT_MARGIN)
    this.dom.dataset.outline = (a.wrap === 'tight' || a.wrap === 'through') && src ? outlines.get(src) || '' : ''
    scheduleAlign(this.view.dom as HTMLElement)
    this.bar.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === a.wrap))
    this.bar.querySelectorAll<HTMLButtonElement>('button[data-side]').forEach((b) => {
      b.classList.toggle('on', b.dataset.side === a.side)
      // Left/right apply to floating modes, left/centre/right to top-and-bottom.
      b.hidden = !(isFloat(a.wrap) ? b.dataset.side !== 'center' : a.wrap === 'topBottom')
    })
    // Vertical alignment: on its text line (in line), or beside its paragraph's text (the other
    // modes except top-and-bottom, which has a line of its own).
    const current = a.wrap === 'inline' ? (a.valign ?? 'bottom') : (a.vpos ?? 'free')
    this.bar.querySelectorAll<HTMLButtonElement>('button[data-valign]').forEach((b) => {
      b.classList.toggle('on', b.dataset.valign === current)
      b.hidden = a.wrap === 'topBottom'
    })
    this.bar.querySelector<HTMLElement>('.aw-image-valign-label')!.hidden = a.wrap === 'topBottom'
    // Pixel fields: show the current values (unless the user is typing in that field).
    const set = (name: string, value: number, show = true) => {
      const input = this.bar.querySelector<HTMLInputElement>(`input[data-field="${name}"]`)!
      const label = input.parentElement as HTMLElement
      label.hidden = !show
      if (document.activeElement !== input) input.value = String(Math.round(value))
    }
    set('width', a.width)
    set('height', a.height)
    set('margin', a.margin ?? DEFAULT_MARGIN, !isAbsolute(a.wrap))
    set('x', a.x, isAbsolute(a.wrap))
    set('y', a.y, isAbsolute(a.wrap))
    this.bar.querySelector<HTMLButtonElement>('button[data-action="lock"]')!.classList.toggle('on', this.lockRatio)
    // The image may have moved or changed size: keep the toolbar next to it.
    requestAnimationFrame(this.placeBar)
  }

  private buildBar(): HTMLElement {
    const bar = document.createElement('span')
    bar.className = 'aw-image-bar'
    const row1 = document.createElement('span')
    const row2 = document.createElement('span')
    row1.className = row2.className = 'aw-image-row'
    const grip = document.createElement('span')
    grip.className = 'aw-image-grip'
    grip.textContent = '⠿'
    grip.dataset.title = 'Drag to move this toolbar. Double-click to put it back above the image.'
    grip.addEventListener('mousedown', (e) => this.dragBar(e))
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault()
      setBarOffset(null)
      this.placeBar()
    })
    const rows = document.createElement('span')
    rows.className = 'aw-image-rows'
    rows.append(row1, row2)
    bar.append(grip, rows)
    const add = (row: HTMLElement, label: string, title: string, data: Record<string, string>, onClick: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      // English text in data attributes; relabel() shows it in the interface language.
      b.dataset.label = label
      b.dataset.title = title
      Object.assign(b.dataset, data)
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick()
      })
      row.appendChild(b)
      return b
    }
    for (const m of WRAP_MODES) add(row1, m.label, m.title, { mode: m.mode }, () => this.setWrap(m.mode))
    const sep = document.createElement('span')
    sep.className = 'aw-image-sep'
    row1.appendChild(sep)
    add(row1, '⇤', 'Left', { side: 'left' }, () => this.setAttrs({ side: 'left' }))
    add(row1, '↔', 'Centre', { side: 'center' }, () => this.setAttrs({ side: 'center' }))
    add(row1, '⇥', 'Right', { side: 'right' }, () => this.setAttrs({ side: 'right' }))
    add(row1, 'Embed', 'This image is linked to a file on disk: copy it into the document instead', { action: 'embed' }, () => {
      const a = this.attrs
      const src = displaySrc(a)
      if (src) this.setAttrs({ src, link: '' })
    })
    add(row1, 'Delete', 'Delete image', { action: 'delete' }, () => {
      const pos = this.getPos()
      if (pos !== undefined) this.view.dispatch(this.view.state.tr.delete(pos, pos + 1))
    })

    // Second row: exact sizes and positions in pixels.
    const field = (name: string, label: string, title: string, min: number) => {
      const wrap = document.createElement('label')
      wrap.className = 'aw-image-field'
      wrap.dataset.title = title
      const text = document.createElement('span')
      text.dataset.label = label
      wrap.append(text)
      const input = document.createElement('input')
      input.type = 'number'
      input.min = String(min)
      input.step = '1'
      input.dataset.field = name
      // Apply on Enter or when leaving the field; arrows/typing don't move the image yet.
      input.addEventListener('change', () => this.applyField(name, Number(input.value)))
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') input.blur()
        if (e.key === 'Escape') {
          input.value = ''
          input.blur()
          this.render()
        }
      })
      wrap.append(input, 'px')
      row2.appendChild(wrap)
    }
    field('width', 'W', 'Width in pixels', 8)
    field('height', 'H', 'Height in pixels', 8)
    add(row2, '🔒', 'Keep proportions when changing width or height', { action: 'lock' }, () => {
      this.lockRatio = !this.lockRatio
      this.render()
    })
    field('margin', 'Margin', 'Gap between the image and the text around it, in pixels (all sides for an in-line image)', 0)
    field('x', 'X', 'Horizontal position from the paragraph, in pixels', -2000)
    field('y', 'Y', 'Vertical position from the paragraph, in pixels', -2000)
    const vlabel = document.createElement('span')
    vlabel.className = 'aw-image-valign-label'
    vlabel.dataset.label = 'Align'
    row2.appendChild(vlabel)
    add(row2, 'Top', 'Line the image up with the top of the text (click again to place it freely)', { valign: 'top' }, () => this.setVAlign('top'))
    add(row2, 'Middle', 'Centre the image on the text (click again to place it freely)', { valign: 'middle' }, () => this.setVAlign('middle'))
    add(row2, 'Bottom', 'Line the image up with the bottom of the text (click again to place it freely)', { valign: 'bottom' }, () => this.setVAlign('bottom'))
    this.relabelBar(bar)
    return bar
  }

  private offLanguage: () => void = () => {}

  private relabel() {
    this.relabelBar(this.bar)
  }

  /** Shows the toolbar's labels and tooltips in the interface language. */
  private relabelBar(bar: HTMLElement) {
    bar.querySelectorAll<HTMLElement>('[data-label]').forEach((el) => {
      el.textContent = t(el.dataset.label!)
    })
    bar.querySelectorAll<HTMLElement>('[data-title]').forEach((el) => {
      el.title = t(el.dataset.title!)
    })
  }

  private applyField(name: string, value: number) {
    if (!Number.isFinite(value)) return this.render()
    const a = this.attrs
    const ratio = a.height / a.width || 1
    const v = Math.round(value)
    switch (name) {
      case 'width':
        if (v < 8) return this.render()
        return this.setAttrs(this.lockRatio ? { width: v, height: Math.round(v * ratio) } : { width: v })
      case 'height':
        if (v < 8) return this.render()
        return this.setAttrs(this.lockRatio ? { height: v, width: Math.round(v / ratio) } : { height: v })
      case 'margin':
        return this.setAttrs({ margin: Math.max(0, Math.min(200, v)) })
      case 'x':
        return this.setAttrs({ x: v })
      case 'y':
        // A typed position replaces Top / Middle / Bottom.
        return this.setAttrs({ y: v, vpos: 'free' })
    }
  }

  private placeBar = () => {
    if (!this.bar.isConnected) return
    const r = this.dom.getBoundingClientRect()
    const h = this.bar.offsetHeight
    const w = this.bar.offsetWidth
    let top: number
    let left: number
    if (barOffset) {
      // Where the user dragged it, relative to the image's top-left corner.
      top = r.top + barOffset.dy
      left = r.left + barOffset.dx
    } else {
      // Default: above the image with a clear gap, or below it if there's no room above.
      top = r.top - h - BAR_GAP >= 4 ? r.top - h - BAR_GAP : r.bottom + BAR_GAP
      left = r.left
    }
    top = Math.max(4, Math.min(top, window.innerHeight - h - 4))
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4))
    this.bar.style.left = `${Math.round(left)}px`
    this.bar.style.top = `${Math.round(top)}px`
  }

  /** Drags the toolbar by its grip; it then keeps that spot next to every image. */
  private dragBar(down: MouseEvent) {
    down.preventDefault()
    down.stopPropagation()
    const start = this.bar.getBoundingClientRect()
    const move = (e: MouseEvent) => {
      const r = this.dom.getBoundingClientRect()
      setBarOffset({ dx: start.left + e.clientX - down.clientX - r.left, dy: start.top + e.clientY - down.clientY - r.top })
      this.placeBar()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      this.bar.classList.remove('moving')
    }
    this.bar.classList.add('moving')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private showBar() {
    if (!this.bar.isConnected) document.body.appendChild(this.bar)
    window.addEventListener('scroll', this.placeBar, true)
    window.addEventListener('resize', this.placeBar)
    this.render()
  }

  private hideBar() {
    this.bar.remove()
    window.removeEventListener('scroll', this.placeBar, true)
    window.removeEventListener('resize', this.placeBar)
  }

  /** Changes the wrap mode; switching to behind/in front keeps the image where it is on screen. */
  private setWrap(wrap: WrapMode) {
    const patch: Partial<ImageAttrs> = { wrap }
    if (isAbsolute(wrap) && !isAbsolute(this.attrs.wrap)) {
      const anchor = this.dom.closest('p, h1, h2, h3, h4, h5, h6, li') as HTMLElement | null
      if (anchor) {
        const r = this.dom.getBoundingClientRect()
        const p = anchor.getBoundingClientRect()
        const zoom = zoomOf(this.dom)
        patch.x = Math.round((r.left - p.left) / zoom)
        patch.y = Math.round((r.top - p.top) / zoom)
      }
    }
    if (wrap === 'topBottom' && this.attrs.side !== 'right' && this.attrs.side !== 'left') patch.side = 'center'
    if (isFloat(wrap) && this.attrs.side === 'center') patch.side = 'left'
    this.setAttrs(patch)
  }

  /** Top / Middle / Bottom: on its text line (in line), or beside its paragraph's text, where a second click goes back to free placement. */
  private setVAlign(v: VAlign) {
    if (this.attrs.wrap === 'inline') return this.setAttrs({ valign: v })
    this.setAttrs({ vpos: this.attrs.vpos === v ? 'free' : v })
  }

  /** Changes attributes in one undoable step and keeps the image selected. */
  private setAttrs(patch: Partial<ImageAttrs>) {
    const pos = this.getPos()
    if (pos === undefined) return
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.attrs, ...patch })
    tr.setSelection(NodeSelection.create(tr.doc, pos))
    this.view.dispatch(tr)
  }

  private select() {
    const pos = this.getPos()
    if (pos === undefined) return
    const sel = this.view.state.selection
    if (!(sel instanceof NodeSelection && sel.from === pos)) {
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    }
    this.view.focus()
  }

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    this.select()
    const corner = (e.target as HTMLElement).dataset.corner
    if (corner) startResize(this, e, corner)
    else startMove(this, e)
  }

  // ---- used by the drag helpers below ----
  get element() {
    return this.dom
  }
  get editorView() {
    return this.view
  }
  get position() {
    return this.getPos()
  }
  get current() {
    return this.attrs
  }
  get keepRatio() {
    return this.lockRatio
  }
  commit(patch: Partial<ImageAttrs>) {
    this.setAttrs(patch)
  }
  restyle() {
    this.render()
  }

  // ---- ProseMirror NodeView interface ----
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }
  selectNode() {
    this.dom.classList.add('selected')
    this.showBar()
  }
  deselectNode() {
    this.dom.classList.remove('selected')
    this.hideBar()
  }
  destroy() {
    this.hideBar()
    this.offLanguage()
  }
  stopEvent(event: Event) {
    // We handle mouse and drag events ourselves; keys still go to the editor (Delete, arrows…).
    return /^(mouse|drag|drop|click|dblclick|pointer)/.test(event.type)
  }
  ignoreMutation() {
    return true
  }
}

const DRAG_THRESHOLD = 4

/** The page's view zoom (CSS zoom), so mouse distances on screen can be turned into image pixels. */
function zoomOf(el: Element): number {
  const z = (el as Element & { currentCSSZoom?: number }).currentCSSZoom
  return z && Number.isFinite(z) && z > 0 ? z : 1
}

/** Resize from a corner, keeping the proportions (unless unlocked in the toolbar). */
function startResize(view: ImageView, down: MouseEvent, corner: string) {
  const start = { ...view.current }
  const ratio = start.height / start.width || 1
  const sx = corner.includes('w') ? -1 : 1
  const sy = corner.includes('n') ? -1 : 1
  const el = view.element
  const zoom = zoomOf(el)
  const size = (e: MouseEvent) => {
    const width = Math.max(16, Math.min(PAGE_TEXT_WIDTH * 1.5, start.width + (sx * (e.clientX - down.clientX)) / zoom))
    const height = view.keepRatio ? width * ratio : Math.max(16, start.height + (sy * (e.clientY - down.clientY)) / zoom)
    return { width: Math.round(width), height: Math.round(height) }
  }
  const move = (e: MouseEvent) => {
    const s = size(e)
    el.style.width = `${s.width}px`
    el.style.height = `${s.height}px`
  }
  const up = (e: MouseEvent) => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    const s = size(e)
    if (s.width !== start.width || s.height !== start.height) view.commit(s)
    else view.restyle()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/**
 * Move by dragging. Behind/in front: the image follows the mouse and keeps its new offset.
 * In line: drop it anywhere in the text. Square/tight/through/top-and-bottom: it moves to the
 * paragraph it is dropped on (anchored at its start, like Word); for square/tight/through the
 * page half it is dropped on also chooses the side.
 */
function startMove(view: ImageView, down: MouseEvent) {
  const el = view.element
  const a = view.current
  const pmView = view.editorView
  let dragging = false
  let caret: HTMLElement | null = null
  const zoom = zoomOf(el)
  // Where a behind / in front image is shown now (Top / Middle / Bottom may have moved it).
  const startY = parseFloat(el.style.top)
  const fromY = Number.isFinite(startY) ? startY : a.y

  const dropTarget = (e: MouseEvent) => {
    const hit = pmView.posAtCoords({ left: e.clientX, top: e.clientY })
    if (!hit) return null
    const $pos = pmView.state.doc.resolve(hit.pos)
    if (!$pos.parent.inlineContent) return null
    return isAnchored(a.wrap) ? $pos.start() : hit.pos
  }

  const move = (e: MouseEvent) => {
    const dx = e.clientX - down.clientX
    const dy = e.clientY - down.clientY
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    dragging = true
    if (isAbsolute(a.wrap)) {
      el.style.left = `${Math.round(a.x + dx / zoom)}px`
      el.style.top = `${Math.round(fromY + dy / zoom)}px`
      return
    }
    // Flowing modes: the image follows the mouse, a caret shows where it will land.
    el.style.transform = `translate(${dx / zoom}px, ${dy / zoom}px)`
    el.style.opacity = '0.6'
    el.style.pointerEvents = 'none'
    const target = dropTarget(e)
    if (target !== null) {
      const c = pmView.coordsAtPos(target)
      if (!caret) {
        caret = document.createElement('div')
        caret.className = 'aw-image-drop-caret'
        document.body.appendChild(caret)
      }
      caret.style.cssText = `left:${c.left}px;top:${c.top}px;height:${Math.max(16, c.bottom - c.top)}px`
    }
  }

  const up = (e: MouseEvent) => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    caret?.remove()
    el.style.transform = ''
    el.style.opacity = ''
    el.style.pointerEvents = ''
    if (!dragging) return
    if (isAbsolute(a.wrap)) {
      view.commit({ x: Math.round(a.x + (e.clientX - down.clientX) / zoom), y: Math.round(fromY + (e.clientY - down.clientY) / zoom), vpos: 'free' })
      return
    }
    const from = view.position
    const target = dropTarget(e)
    const page = pmView.dom.getBoundingClientRect()
    const side: Side = isFloat(a.wrap) ? (e.clientX < page.left + page.width / 2 ? 'left' : 'right') : a.side
    if (from === undefined || target === null || ((target === from || target === from + 1) && side === a.side)) {
      view.restyle()
      return
    }
    const node = pmView.state.doc.nodeAt(from)!
    const tr = pmView.state.tr.delete(from, from + 1)
    const at = tr.mapping.map(target)
    tr.insert(at, node.type.create({ ...node.attrs, side }))
    tr.setSelection(NodeSelection.create(tr.doc, at))
    pmView.dispatch(tr.scrollIntoView())
  }

  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

/**
 * "Behind text" images sit under the paragraphs, so clicks normally land on the text. A click
 * on an empty spot over such an image (not on actual characters) selects the image instead.
 */
export function behindImageAt(view: EditorView, x: number, y: number): HTMLElement | null {
  const images = [...view.dom.querySelectorAll<HTMLElement>('.aw-image[data-wrap="behind"]')]
  const hit = images.reverse().find((img) => {
    const r = img.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  })
  if (!hit || isOverText(x, y)) return null
  return hit
}

function isOverText(x: number, y: number): boolean {
  const range = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y)
  if (!range || range.startContainer.nodeType !== 3) return false
  const text = range.startContainer as Text
  for (const offset of [range.startOffset - 1, range.startOffset]) {
    if (offset < 0 || offset >= text.length) continue
    const r = document.createRange()
    r.setStart(text, offset)
    r.setEnd(text, offset + 1)
    for (const box of r.getClientRects()) {
      if (x >= box.left - 1 && x <= box.right + 1 && y >= box.top && y <= box.bottom) return true
    }
  }
  return false
}
