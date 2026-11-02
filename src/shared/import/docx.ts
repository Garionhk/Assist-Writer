// Reads a Word document (.docx) straight into the editor's document (ProseMirror JSON), keeping
// what the editor supports: headings, alignment, quotes, code blocks, lists, bold / italic /
// underline / strike, fonts and sizes, line breaks, and pictures in line or floating with their
// Word wrap settings. Things the editor can't show (tables, text boxes, footnotes) keep their
// text. Tracked changes are read as accepted. Lenient and bounded: odd files give a best-effort
// document, never a hang.
import JSZip from 'jszip'
import type { DocNode } from '../types'
import { DEFAULT_CJK_FONT, DEFAULT_FONT, DEFAULT_SIZE_PT, hasCjk, isCjkFont } from '../export/common'
import { find, kid, kids, parseXml, path, textOf, type XmlEl } from './xml'

/** EMU per pixel (96 dpi). */
const EMU_PER_PX = 9525
/** The editor's page text width in px (816 px page minus 2 × 84 px margins). */
const PAGE_TEXT_WIDTH = 648
/** Unzipped size limits. */
const MAX_PART_BYTES = 200 * 1024 * 1024
const MAX_TOTAL_BYTES = 600 * 1024 * 1024
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_STYLE_DEPTH = 20

type Mark = { type: string; attrs?: Record<string, unknown> }

/** Run properties as Word sets them (undefined = not set at this level). */
interface RunProps {
  b?: boolean
  i?: boolean
  u?: boolean
  strike?: boolean
  vanish?: boolean
  ascii?: string
  eastAsia?: string
  /** Half-points. */
  sz?: number
  /** Inline code (from a code character style). */
  code?: boolean
}

interface StyleDef {
  type: string
  name: string
  basedOn?: string
  pPr?: XmlEl
  rPr?: XmlEl
}

interface ListLevel {
  ordered: boolean
  start: number
}

interface Ctx {
  zip: JSZip
  rels: Map<string, string>
  styles: Map<string, StyleDef>
  defaultParaStyle?: string
  docDefaults: RunProps
  theme: { minorLatin?: string; minorEa?: string; majorLatin?: string; majorEa?: string }
  /** numId → abstract levels (with start overrides). */
  numbering: Map<string, Map<number, ListLevel>>
  footnotes: Map<string, XmlEl>
  endnotes: Map<string, XmlEl>
  /** Notes referenced in the text, in order, for the list at the end. */
  notes: { label: string; foot: boolean; el: XmlEl }[]
  images: Map<string, string | null>
  totalBytes: number
}

/** One paragraph's worth of content before lists and quotes are nested. */
interface Para {
  kind: 'paragraph' | 'heading' | 'codeBlock' | 'horizontalRule'
  level: number
  align: string | null
  quote: boolean
  list: { numId: string; ilvl: number; ordered: boolean; start: number } | null
  /** Left indent in twips (to place continuation paragraphs inside list items). */
  indent: number
  content: DocNode[]
}

const onOff = (el: XmlEl | undefined): boolean | undefined => {
  if (!el) return undefined
  const v = el.attrs['w:val']
  return v === undefined || !(v === 'false' || v === '0' || v === 'off' || v === 'none')
}
const int = (v: string | undefined, d = 0): number => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : d
}
const clampNum = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function joinPath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

async function readText(ctx: Pick<Ctx, 'zip' | 'totalBytes'>, name: string): Promise<string | null> {
  const f = ctx.zip.file(name)
  if (!f) return null
  const bytes = await f.async('uint8array')
  if (bytes.length > MAX_PART_BYTES) throw new Error('This document is too large to open.')
  ctx.totalBytes += bytes.length
  if (ctx.totalBytes > MAX_TOTAL_BYTES) throw new Error('This document is too large to open.')
  return new TextDecoder('utf-8').decode(bytes)
}

async function readXml(ctx: Pick<Ctx, 'zip' | 'totalBytes'>, name: string): Promise<XmlEl | null> {
  const t = await readText(ctx, name)
  return t === null ? null : parseXml(t)
}

/** Relationships of a part: id → target path inside the zip (external targets are left out). */
async function readRels(ctx: Pick<Ctx, 'zip' | 'totalBytes'>, part: string): Promise<{ byId: Map<string, string>; byType: Map<string, string> }> {
  const slash = part.lastIndexOf('/')
  const relsName = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
  const byId = new Map<string, string>()
  const byType = new Map<string, string>()
  const xml = await readXml(ctx, relsName)
  for (const r of kids(xml ?? undefined, 'Relationship')) {
    if (r.attrs.TargetMode === 'External') continue
    const target = joinPath(part, r.attrs.Target ?? '')
    byId.set(r.attrs.Id ?? '', target)
    const type = (r.attrs.Type ?? '').split('/').pop() ?? ''
    if (!byType.has(type)) byType.set(type, target)
  }
  return { byId, byType }
}

// ---- Run properties and styles --------------------------------------------------------------

function parseRPr(rPr: XmlEl | undefined, ctx: Pick<Ctx, 'theme' | 'styles'>): RunProps {
  const p: RunProps = {}
  if (!rPr) return p
  p.b = onOff(kid(rPr, 'w:b'))
  p.i = onOff(kid(rPr, 'w:i'))
  const u = kid(rPr, 'w:u')
  if (u) p.u = (u.attrs['w:val'] ?? 'single') !== 'none'
  const strike = onOff(kid(rPr, 'w:strike')) ?? onOff(kid(rPr, 'w:dstrike'))
  if (strike !== undefined) p.strike = strike
  p.vanish = onOff(kid(rPr, 'w:vanish'))
  const fonts = kid(rPr, 'w:rFonts')
  if (fonts) {
    const theme = (t: string | undefined) => {
      if (!t) return undefined
      if (t.startsWith('major')) return t.includes('EastAsia') ? ctx.theme.majorEa : ctx.theme.majorLatin
      return t.includes('EastAsia') ? ctx.theme.minorEa : ctx.theme.minorLatin
    }
    p.ascii = fonts.attrs['w:ascii'] ?? fonts.attrs['w:hAnsi'] ?? theme(fonts.attrs['w:asciiTheme'] ?? fonts.attrs['w:hAnsiTheme'])
    p.eastAsia = fonts.attrs['w:eastAsia'] ?? theme(fonts.attrs['w:eastAsiaTheme'])
  }
  const sz = kid(rPr, 'w:sz')
  if (sz) p.sz = clampNum(int(sz.attrs['w:val'], 24), 2, 3276)
  const rStyle = kid(rPr, 'w:rStyle')?.attrs['w:val']
  if (rStyle) {
    const name = ctx.styles.get(rStyle)?.name ?? rStyle
    if (/code|source|verbatim|preformatted|keyboard|typewriter/i.test(name)) p.code = true
  }
  return p
}

const merge = (...layers: RunProps[]): RunProps => {
  const out: RunProps = {}
  for (const l of layers) for (const [k, v] of Object.entries(l)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

/** A style's run properties including the styles it's based on. */
function styleRunProps(ctx: Ctx, id: string | undefined, depth = 0): RunProps {
  const s = id ? ctx.styles.get(id) : undefined
  if (!s || depth > MAX_STYLE_DEPTH) return {}
  return merge(styleRunProps(ctx, s.basedOn, depth + 1), parseRPr(s.rPr, ctx))
}

/** A paragraph property element from the style chain (first found, nearest style first). */
function stylePPr(ctx: Ctx, id: string | undefined, name: string, depth = 0): XmlEl | undefined {
  const s = id ? ctx.styles.get(id) : undefined
  if (!s || depth > MAX_STYLE_DEPTH) return undefined
  return kid(s.pPr, name) ?? stylePPr(ctx, s.basedOn, name, depth + 1)
}

/** Names of a style and the styles it's based on, lower-case without spaces ("heading1"). */
function styleNames(ctx: Ctx, id: string | undefined, depth = 0): string[] {
  const s = id ? ctx.styles.get(id) : undefined
  if (!s || depth > MAX_STYLE_DEPTH) return []
  return [s.name.toLowerCase().replace(/\s+/g, ''), id!.toLowerCase(), ...styleNames(ctx, s.basedOn, depth + 1)]
}

/** The editor marks for a run's effective properties. */
function marksFor(p: RunProps, text: string, inCode: boolean): Mark[] {
  const marks: Mark[] = []
  if (p.b) marks.push({ type: 'bold' })
  if (p.i) marks.push({ type: 'italic' })
  if (p.u) marks.push({ type: 'underline' })
  if (p.strike) marks.push({ type: 'strike' })
  if (p.code && !inCode) {
    marks.push({ type: 'code' })
    return marks // code text uses the code font
  }
  if (inCode) return marks
  // One font per run in the editor: the east-Asian font for Chinese text when it was chosen on
  // purpose, otherwise the Latin one (a Latin font paired with the default Chinese font stays Latin).
  let font = p.ascii
  if (p.ascii && isCjkFont(p.ascii)) {
    // A Chinese font chosen for the whole run.
  } else if (p.eastAsia && p.eastAsia !== DEFAULT_CJK_FONT && hasCjk(text) && !/[A-Za-z]/.test(text)) font = p.eastAsia
  else if (!p.ascii && p.eastAsia && p.eastAsia !== DEFAULT_CJK_FONT) font = p.eastAsia
  const attrs: Record<string, string> = {}
  if (font && font !== DEFAULT_FONT && font !== DEFAULT_CJK_FONT) attrs.fontFamily = font
  if (p.sz !== undefined && p.sz / 2 !== DEFAULT_SIZE_PT) attrs.fontSize = `${p.sz / 2}pt`
  if (Object.keys(attrs).length) marks.push({ type: 'textStyle', attrs })
  return marks
}

// ---- Pictures --------------------------------------------------------------------------------

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** A picture part as a data URL (PNG/JPEG only; other formats are skipped). */
async function imageSrc(ctx: Ctx, relId: string | undefined, rels: Map<string, string>): Promise<string | null> {
  const target = relId ? rels.get(relId) : undefined
  if (!target) return null
  if (ctx.images.has(target)) return ctx.images.get(target)!
  let src: string | null = null
  const f = ctx.zip.file(target)
  if (f) {
    const bytes = await f.async('uint8array')
    ctx.totalBytes += bytes.length
    if (bytes.length <= MAX_IMAGE_BYTES && ctx.totalBytes <= MAX_TOTAL_BYTES) {
      const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
      if (png || jpeg) src = `data:image/${png ? 'png' : 'jpeg'};base64,${base64(bytes)}`
    }
  }
  ctx.images.set(target, src)
  return src
}

const emuPx = (v: string | undefined) => Math.round(clampNum(int(v), -1e10, 1e10) / EMU_PER_PX)

/** A DrawingML picture (`w:drawing`): an image node, or the text of a text box. */
async function drawing(ctx: Ctx, el: XmlEl, rels: Map<string, string>, out: Inline): Promise<void> {
  const box = kid(el, 'wp:inline') ?? kid(el, 'wp:anchor')
  if (!box) return
  const blip = find(box, 'a:blip')
  const src = blip ? await imageSrc(ctx, blip.attrs['r:embed'], rels) : null
  if (!src) {
    // A shape or text box: keep its text as paragraphs after this one.
    const txbx = find(box, 'w:txbxContent')
    if (txbx) out.after.push(txbx)
    return
  }
  const ext = kid(box, 'wp:extent')
  const width = clampNum(emuPx(ext?.attrs.cx) || 100, 8, 4000)
  const height = clampNum(emuPx(ext?.attrs.cy) || 100, 8, 4000)
  const doc = kid(box, 'wp:docPr')
  const alt = doc?.attrs.descr || doc?.attrs.title || ''
  const attrs = { src, link: '', alt, width, height, wrap: 'inline', side: 'left', valign: 'bottom', vpos: 'free', margin: 12, x: 0, y: 0 }
  if (box.name === 'wp:anchor') {
    const behind = box.attrs.behindDoc === '1' || box.attrs.behindDoc === 'true'
    const wrapEl = kids(box).find((k) => k.name.startsWith('wp:wrap'))
    const wrap =
      { 'wp:wrapSquare': 'square', 'wp:wrapTight': 'tight', 'wp:wrapThrough': 'through', 'wp:wrapTopAndBottom': 'topBottom' }[wrapEl?.name ?? ''] ??
      (behind ? 'behind' : 'front')
    const posH = kid(box, 'wp:positionH')
    const posV = kid(box, 'wp:positionV')
    const align = kid(posH, 'wp:align') ? textOf(kid(posH, 'wp:align')!).trim() : null
    const offX = kid(posH, 'wp:posOffset') ? emuPx(textOf(kid(posH, 'wp:posOffset')!).trim()) : 0
    const offY = kid(posV, 'wp:posOffset') ? emuPx(textOf(kid(posV, 'wp:posOffset')!).trim()) : 0
    // Vertical alignment (top / centre / bottom) becomes Top / Middle / Bottom beside the text.
    const alignV = kid(posV, 'wp:align') ? textOf(kid(posV, 'wp:align')!).trim() : null
    const vpos = alignV === 'top' || alignV === 'inside' ? 'top' : alignV === 'center' ? 'middle' : alignV === 'bottom' || alignV === 'outside' ? 'bottom' : 'free'
    if (wrap !== 'topBottom') attrs.vpos = vpos
    const x =
      align === 'right' || align === 'outside'
        ? PAGE_TEXT_WIDTH - width
        : align === 'center'
          ? Math.round((PAGE_TEXT_WIDTH - width) / 2)
          : align
            ? 0
            : offX
    const mid = x + width / 2
    attrs.wrap = wrap
    if (wrap === 'topBottom') {
      attrs.side = align === 'center' || Math.abs(mid - PAGE_TEXT_WIDTH / 2) < 24 ? 'center' : mid > PAGE_TEXT_WIDTH / 2 ? 'right' : 'left'
      attrs.margin = Math.max(emuPx(box.attrs.distT), emuPx(box.attrs.distB))
    } else if (wrap === 'behind' || wrap === 'front') {
      attrs.x = clampNum(x, -2000, 2000)
      attrs.y = vpos === 'free' ? clampNum(offY, -2000, 2000) : 0
    } else {
      attrs.side = align === 'right' || align === 'outside' || (!align && mid > PAGE_TEXT_WIDTH / 2) ? 'right' : 'left'
      attrs.margin = Math.max(emuPx(box.attrs.distL), emuPx(box.attrs.distR), emuPx(box.attrs.distB))
    }
    attrs.margin = clampNum(attrs.margin, 0, 200)
    out.anchored.push({ type: 'image', attrs })
    return
  }
  attrs.margin = clampNum(Math.max(emuPx(box.attrs.distT), emuPx(box.attrs.distB), emuPx(box.attrs.distL), emuPx(box.attrs.distR)), 0, 200)
  out.push({ type: 'image', attrs })
}

/** An older VML picture (`w:pict`): an in-line image, or the text of a text box. */
async function vmlPicture(ctx: Ctx, el: XmlEl, rels: Map<string, string>, out: Inline): Promise<void> {
  const data = find(el, 'v:imagedata')
  const src = data ? await imageSrc(ctx, data.attrs['r:id'], rels) : null
  if (!src) {
    const txbx = find(el, 'w:txbxContent')
    if (txbx) out.after.push(txbx)
    return
  }
  const style = (find(el, 'v:shape') ?? find(el, 'v:rect'))?.attrs.style ?? ''
  const size = (prop: string) => {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)(pt|px|in)?`, 'i').exec(style)
    if (!m) return 100
    const v = parseFloat(m[1])
    return Math.round(m[2] === 'px' ? v : m[2] === 'in' ? v * 96 : (v * 96) / 72)
  }
  out.push({
    type: 'image',
    attrs: { src, link: '', alt: '', width: clampNum(size('width'), 8, 4000), height: clampNum(size('height'), 8, 4000), wrap: 'inline', side: 'left', margin: 0, x: 0, y: 0 }
  })
}

// ---- Paragraph content -----------------------------------------------------------------------

/** Inline content being collected for one paragraph. */
interface Inline {
  nodes: DocNode[]
  /** Wrapped pictures: anchored at the start of the paragraph, like Word. */
  anchored: DocNode[]
  /** Text boxes found inside: their paragraphs follow this one. */
  after: XmlEl[]
  push(n: DocNode): void
}

function newInline(): Inline {
  const nodes: DocNode[] = []
  return {
    nodes,
    anchored: [],
    after: [],
    push(n) {
      const last = nodes[nodes.length - 1]
      // Merge neighbouring text with the same marks.
      if (n.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) last.text += n.text ?? ''
      else nodes.push(n)
    }
  }
}

interface RunState {
  /** Paragraph-level run properties (defaults + paragraph style). */
  base: RunProps
  inCode: boolean
  rels: Map<string, string>
  /** Complex fields: true while inside a field's instructions (hidden). */
  fields: boolean[]
}

async function runContent(ctx: Ctx, run: XmlEl, st: RunState, out: Inline): Promise<void> {
  const rPr = kid(run, 'w:rPr')
  const direct = parseRPr(rPr, ctx)
  const rStyle = kid(rPr, 'w:rStyle')?.attrs['w:val']
  const p = merge(st.base, styleRunProps(ctx, rStyle), direct)
  if (p.vanish) return
  const text = (t: string) => {
    if (!t || st.fields.some((f) => f)) return
    const marks = marksFor(p, t, st.inCode)
    out.push(marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t })
  }
  for (const c of kids(run)) {
    switch (c.name) {
      case 'w:t':
        text(textOf(c))
        break
      case 'w:tab':
      case 'w:ptab':
        text('\t')
        break
      case 'w:noBreakHyphen':
        text('-')
        break
      case 'w:br':
      case 'w:cr':
        if (c.attrs['w:type'] === 'page' || c.attrs['w:type'] === 'column') break
        if (!st.fields.some((f) => f)) out.push({ type: 'hardBreak' })
        break
      case 'w:sym': {
        const code = parseInt(c.attrs['w:char'] ?? '', 16)
        // Symbol-font characters live at F000+ (private use); keep the plain-Unicode ones.
        if (Number.isFinite(code) && code >= 0x20 && (code < 0xe000 || code > 0xf8ff)) text(String.fromCodePoint(code))
        break
      }
      case 'w:fldChar': {
        const t = c.attrs['w:fldCharType']
        if (t === 'begin') st.fields.push(true)
        else if (t === 'separate' && st.fields.length) st.fields[st.fields.length - 1] = false
        else if (t === 'end') st.fields.pop()
        break
      }
      case 'w:drawing':
        if (!st.fields.some((f) => f)) await drawing(ctx, c, st.rels, out)
        break
      case 'w:pict':
        if (!st.fields.some((f) => f)) await vmlPicture(ctx, c, st.rels, out)
        break
      case 'mc:AlternateContent': {
        const choice = kid(c, 'mc:Choice') ?? kid(c, 'mc:Fallback')
        if (choice) await runContent(ctx, { ...run, children: choice.children }, st, out)
        break
      }
      case 'w:footnoteReference':
      case 'w:endnoteReference': {
        const foot = c.name === 'w:footnoteReference'
        const el = (foot ? ctx.footnotes : ctx.endnotes).get(c.attrs['w:id'] ?? '')
        if (el) {
          // Footnotes are numbered [1], [2]…, endnotes [E1], [E2]…
          const count = ctx.notes.filter((n) => n.foot === foot).length + 1
          const label = foot ? `[${count}]` : `[E${count}]`
          ctx.notes.push({ label, foot, el })
          text(label)
        }
        break
      }
    }
  }
}

/** Walks a paragraph's children (runs, links, insertions, fields…). Deleted text is skipped. */
async function paraContent(ctx: Ctx, parent: XmlEl, st: RunState, out: Inline): Promise<void> {
  for (const c of kids(parent)) {
    switch (c.name) {
      case 'w:r':
        await runContent(ctx, c, st, out)
        break
      case 'w:hyperlink':
      case 'w:ins':
      case 'w:moveTo':
      case 'w:smartTag':
      case 'w:customXml':
      case 'w:fldSimple':
      case 'w:dir':
      case 'w:bdo':
        await paraContent(ctx, c, st, out)
        break
      case 'w:sdt':
        await paraContent(ctx, kid(c, 'w:sdtContent') ?? c, st, out)
        break
      case 'mc:AlternateContent': {
        const choice = kid(c, 'mc:Choice') ?? kid(c, 'mc:Fallback')
        if (choice) await paraContent(ctx, choice, st, out)
        break
      }
      // w:del, w:moveFrom, w:pPr, bookmarks, comments: nothing to show.
    }
  }
}

function headingLevel(ctx: Ctx, styleId: string | undefined): number {
  const names = styleNames(ctx, styleId)
  for (const n of names) {
    const m = /^heading([1-6])$/.exec(n)
    if (m) return Number(m[1])
    if (n === 'title') return 1
    if (n === 'subtitle') return 2
  }
  const lvl = stylePPr(ctx, styleId, 'w:outlineLvl')?.attrs['w:val']
  return lvl !== undefined && int(lvl, 9) < 6 ? int(lvl) + 1 : 0
}

/** Reads a body (document body, table cell, text box, note) into flat paragraphs. */
async function readBlocks(ctx: Ctx, body: XmlEl, rels: Map<string, string>, out: Para[], depth = 0): Promise<void> {
  if (depth > 32) return
  for (const c of kids(body)) {
    switch (c.name) {
      case 'w:p':
        await readParagraph(ctx, c, rels, out, depth)
        break
      case 'w:tbl':
        await readTable(ctx, c, rels, out, depth)
        break
      case 'w:sdt':
        await readBlocks(ctx, kid(c, 'w:sdtContent') ?? c, rels, out, depth + 1)
        break
      case 'w:customXml':
      case 'w:ins':
      case 'w:moveTo':
        await readBlocks(ctx, c, rels, out, depth + 1)
        break
      case 'mc:AlternateContent': {
        const choice = kid(c, 'mc:Choice') ?? kid(c, 'mc:Fallback')
        if (choice) await readBlocks(ctx, choice, rels, out, depth + 1)
        break
      }
    }
  }
}

async function readParagraph(ctx: Ctx, p: XmlEl, rels: Map<string, string>, out: Para[], depth: number): Promise<void> {
  const pPr = kid(p, 'w:pPr')
  const styleId = kid(pPr, 'w:pStyle')?.attrs['w:val'] ?? ctx.defaultParaStyle
  const names = styleNames(ctx, styleId)
  const level = headingLevel(ctx, styleId)
  const code = names.some((n) => /^(code|sourcecode|htmlpreformatted|plaintext|codeblock)$/.test(n))
  const quote = !level && names.some((n) => n === 'quote' || n === 'intensequote' || n === 'blocktext')
  // Headings keep the editor's heading look: their style's font and size aren't copied.
  const base = level ? {} : merge(ctx.docDefaults, styleRunProps(ctx, styleId))
  const inline = newInline()
  await paraContent(ctx, p, { base, inCode: code, rels, fields: [] }, inline)

  const jc = (kid(pPr, 'w:jc') ?? stylePPr(ctx, styleId, 'w:jc'))?.attrs['w:val']
  const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' || jc === 'distribute' ? 'justify' : null
  const numPr = kid(pPr, 'w:numPr') ?? stylePPr(ctx, styleId, 'w:numPr')
  const numId = kid(numPr, 'w:numId')?.attrs['w:val']
  const ilvl = clampNum(int(kid(numPr, 'w:ilvl')?.attrs['w:val']), 0, 5)
  const lvl = numId && numId !== '0' ? ctx.numbering.get(numId)?.get(ilvl) : undefined
  const ind = kid(pPr, 'w:ind') ?? stylePPr(ctx, styleId, 'w:ind')
  const indent = int(ind?.attrs['w:left'] ?? ind?.attrs['w:start'])
  const hasBottomRule = !!path(pPr, 'w:pBdr', 'w:bottom')

  const content = [...inline.anchored, ...inline.nodes]
  const isEmpty = !content.length
  out.push({
    kind: hasBottomRule && isEmpty ? 'horizontalRule' : code ? 'codeBlock' : level ? 'heading' : 'paragraph',
    level,
    align,
    quote,
    list: lvl && !code && !level ? { numId: numId!, ilvl, ordered: lvl.ordered, start: lvl.start } : null,
    indent,
    content
  })
  for (const box of inline.after) await readBlocks(ctx, box, rels, out, depth + 1)
}

/** Tables become one paragraph per row, the cells separated by tabs. */
async function readTable(ctx: Ctx, tbl: XmlEl, rels: Map<string, string>, out: Para[], depth: number): Promise<void> {
  for (const tr of kids(tbl, 'w:tr')) {
    const row: DocNode[] = []
    let first = true
    for (const tc of kids(tr, 'w:tc')) {
      const cell: Para[] = []
      await readBlocks(ctx, tc, rels, cell, depth + 1)
      if (!first) row.push({ type: 'text', text: '\t' })
      first = false
      cell.forEach((para, k) => {
        if (k > 0 && para.content.length) row.push({ type: 'text', text: ' ' })
        row.push(...para.content)
      })
    }
    if (row.some((n) => n.type !== 'text' || (n.text ?? '').trim())) {
      out.push({ kind: 'paragraph', level: 0, align: null, quote: false, list: null, indent: 0, content: row })
    }
  }
}

// ---- Nesting lists and quotes ------------------------------------------------------------------

const TWIPS_PER_LEVEL = 720

function blockNode(p: Para): DocNode {
  if (p.kind === 'horizontalRule') return { type: 'horizontalRule' }
  if (p.kind === 'codeBlock') {
    // Code blocks hold plain text: line breaks become newlines, pictures are dropped.
    const text = p.content.map((n) => (n.type === 'text' ? n.text : n.type === 'hardBreak' ? '\n' : '')).join('')
    return { type: 'codeBlock', attrs: { language: null }, content: text ? [{ type: 'text', text }] : undefined }
  }
  const attrs: Record<string, unknown> = { textAlign: p.align }
  if (p.kind === 'heading') attrs.level = p.level
  const node: DocNode = { type: p.kind, attrs }
  if (p.content.length) node.content = p.content
  return node
}

/** Turns flat paragraphs into the editor's tree: list items in (nested) lists, quotes, code. */
function nest(paras: Para[]): DocNode[] {
  const out: DocNode[] = []
  // Open lists, outermost first; each remembers its node and Word list id.
  let lists: { node: DocNode; numId: string }[] = []
  let quote: DocNode | null = null
  let prevCode: DocNode | null = null

  const target = () => (quote ? quote.content! : out)
  const closeLists = () => (lists = [])
  const lastItem = (list: DocNode) => list.content![list.content!.length - 1]

  for (const p of paras) {
    // Consecutive code paragraphs make one code block.
    if (p.kind === 'codeBlock' && !p.list) {
      closeLists()
      const node = blockNode(p)
      if (prevCode) {
        const prevText = prevCode.content?.[0]?.text ?? ''
        const text = `${prevText}\n${node.content?.[0]?.text ?? ''}`
        prevCode.content = [{ type: 'text', text }]
      } else {
        if (quote && !p.quote) quote = null
        target().push(node)
        prevCode = node
      }
      continue
    }
    prevCode = null

    if (p.quote && !p.list) {
      if (!quote || lists.length) {
        closeLists()
        quote = { type: 'blockquote', content: [] }
        out.push(quote)
      }
      quote.content!.push(blockNode(p))
      continue
    }
    if (!p.list && quote) quote = null

    if (p.list) {
      if (quote && !p.quote) quote = null
      const depth = p.list.ilvl + 1
      // Close deeper lists, and a list of another kind or id at this depth.
      if (lists.length > depth) lists = lists.slice(0, depth)
      const top = lists[depth - 1]
      const listType = p.list.ordered ? 'orderedList' : 'bulletList'
      if (top && (top.node.type !== listType || (top.numId !== p.list.numId && depth === 1))) lists = lists.slice(0, depth - 1)
      // Open lists down to this depth.
      while (lists.length < depth) {
        const node: DocNode = { type: lists.length === depth - 1 ? listType : 'bulletList', content: [] }
        if (node.type === 'orderedList') node.attrs = { start: p.list.start }
        const parent = lists[lists.length - 1]
        if (parent) {
          let item = lastItem(parent.node)
          if (!item) {
            item = { type: 'listItem', content: [{ type: 'paragraph' }] }
            parent.node.content!.push(item)
          }
          item.content!.push(node)
        } else {
          target().push(node)
        }
        lists.push({ node, numId: p.list.numId })
      }
      lists[depth - 1].node.content!.push({ type: 'listItem', content: [blockNode({ ...p, kind: 'paragraph' })] })
      continue
    }

    // A paragraph indented like a list level continues the item above it.
    const level = Math.round(p.indent / TWIPS_PER_LEVEL)
    if (lists.length && p.kind === 'paragraph' && level >= 1 && level <= lists.length && p.indent % TWIPS_PER_LEVEL === 0) {
      lists = lists.slice(0, level)
      const item = lastItem(lists[level - 1].node)
      if (item) {
        item.content!.push(blockNode(p))
        continue
      }
    }
    closeLists()
    target().push(blockNode(p))
  }
  return out
}

// ---- Package-level parts -----------------------------------------------------------------------

async function readStyles(ctx: Ctx, part: string | undefined): Promise<void> {
  const xml = part ? await readXml(ctx, part) : null
  if (!xml) return
  for (const s of kids(xml, 'w:style')) {
    const id = s.attrs['w:styleId']
    if (!id) continue
    ctx.styles.set(id, {
      type: s.attrs['w:type'] ?? 'paragraph',
      name: kid(s, 'w:name')?.attrs['w:val'] ?? id,
      basedOn: kid(s, 'w:basedOn')?.attrs['w:val'],
      pPr: kid(s, 'w:pPr'),
      rPr: kid(s, 'w:rPr')
    })
    const isDefault = s.attrs['w:default'] === '1' || s.attrs['w:default'] === 'true' || s.attrs['w:default'] === 'on'
    if (s.attrs['w:type'] === 'paragraph' && isDefault) ctx.defaultParaStyle = id
  }
  ctx.docDefaults = parseRPr(path(xml, 'w:docDefaults', 'w:rPrDefault', 'w:rPr'), ctx)
}

async function readTheme(ctx: Ctx, part: string | undefined): Promise<void> {
  const xml = part ? await readXml(ctx, part) : null
  const scheme = find(xml ?? undefined, 'a:fontScheme')
  const face = (font: string, kind: string) => {
    const v = path(scheme, font, kind)?.attrs.typeface
    return v || undefined
  }
  ctx.theme = {
    majorLatin: face('a:majorFont', 'a:latin'),
    majorEa: face('a:majorFont', 'a:ea'),
    minorLatin: face('a:minorFont', 'a:latin'),
    minorEa: face('a:minorFont', 'a:ea')
  }
}

async function readNumbering(ctx: Ctx, part: string | undefined): Promise<void> {
  const xml = part ? await readXml(ctx, part) : null
  if (!xml) return
  const abstract = new Map<string, Map<number, ListLevel>>()
  for (const a of kids(xml, 'w:abstractNum')) {
    const levels = new Map<number, ListLevel>()
    for (const l of kids(a, 'w:lvl')) {
      const fmt = kid(l, 'w:numFmt')?.attrs['w:val'] ?? 'decimal'
      levels.set(clampNum(int(l.attrs['w:ilvl']), 0, 8), {
        ordered: fmt !== 'bullet' && fmt !== 'none',
        start: clampNum(int(kid(l, 'w:start')?.attrs['w:val'], 1), 0, 1_000_000)
      })
    }
    abstract.set(a.attrs['w:abstractNumId'] ?? '', levels)
  }
  for (const n of kids(xml, 'w:num')) {
    const levels = new Map(abstract.get(kid(n, 'w:abstractNumId')?.attrs['w:val'] ?? '') ?? [])
    for (const o of kids(n, 'w:lvlOverride')) {
      const ilvl = clampNum(int(o.attrs['w:ilvl']), 0, 8)
      const start = kid(o, 'w:startOverride')?.attrs['w:val']
      const lvl = levels.get(ilvl)
      if (lvl && start !== undefined) levels.set(ilvl, { ...lvl, start: clampNum(int(start, 1), 0, 1_000_000) })
    }
    ctx.numbering.set(n.attrs['w:numId'] ?? '', levels)
  }
}

async function readNotes(ctx: Ctx, part: string | undefined, into: Map<string, XmlEl>, name: string): Promise<void> {
  const xml = part ? await readXml(ctx, part) : null
  for (const n of kids(xml ?? undefined, name)) {
    const type = n.attrs['w:type']
    if (type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') continue
    into.set(n.attrs['w:id'] ?? '', n)
  }
}

/** Reads a .docx file into the editor's document. */
export async function docxToDoc(bytes: Uint8Array): Promise<DocNode> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new Error('This is not a Word document (.docx), or the file is damaged.')
  }
  const probe = { zip, totalBytes: 0 }
  const pkg = await readRels(probe, '')
  const main = pkg.byType.get('officeDocument') ?? 'word/document.xml'
  const { byId: rels, byType } = await readRels(probe, main)
  const ctx: Ctx = {
    zip,
    rels,
    styles: new Map(),
    docDefaults: {},
    theme: {},
    numbering: new Map(),
    footnotes: new Map(),
    endnotes: new Map(),
    notes: [],
    images: new Map(),
    totalBytes: probe.totalBytes
  }
  await readTheme(ctx, byType.get('theme'))
  await readStyles(ctx, byType.get('styles'))
  await readNumbering(ctx, byType.get('numbering'))
  await readNotes(ctx, byType.get('footnotes'), ctx.footnotes, 'w:footnote')
  await readNotes(ctx, byType.get('endnotes'), ctx.endnotes, 'w:endnote')

  const xml = await readXml(ctx, main)
  const body = kid(xml ?? undefined, 'w:body')
  if (!body) throw new Error('This Word document has no content that can be read.')
  const paras: Para[] = []
  await readBlocks(ctx, body, rels, paras)

  // Footnotes and endnotes follow the text, each starting with its number.
  const noteRels = new Map<boolean, Map<string, string>>()
  for (const note of ctx.notes) {
    if (!noteRels.has(note.foot)) {
      const part = byType.get(note.foot ? 'footnotes' : 'endnotes')
      noteRels.set(note.foot, part ? (await readRels(ctx, part)).byId : new Map())
    }
    const start = paras.length
    await readBlocks(ctx, note.el, noteRels.get(note.foot)!, paras)
    const first = paras[start]
    if (first) first.content.unshift({ type: 'text', text: `${note.label} ` })
  }

  const content = nest(paras)
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}
