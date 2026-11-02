import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Tab,
  TextRun,
  TextWrappingSide,
  TextWrappingType,
  VerticalPositionAlign,
  VerticalPositionRelativeFrom
} from 'docx'
import JSZip from 'jszip'
import type { DocNode } from '../types'
import { imageAttrs, imageData } from './images'
import {
  Block,
  DEFAULT_CJK_FONT,
  DEFAULT_FONT,
  DEFAULT_SIZE_PT,
  flattenBlocks,
  isCjkFont,
  runStyle
} from './common'

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
]

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
}

/**
 * Word picks the font per character class: ascii/hAnsi for Latin text and eastAsia for
 * Chinese. A Latin font is paired with the default Chinese font so mixed text renders well.
 */
export function wordFont(font: string | null): { ascii: string; hAnsi: string; eastAsia: string; cs: string } {
  const latin = font ?? DEFAULT_FONT
  const eastAsia = font && isCjkFont(font) ? font : DEFAULT_CJK_FONT
  return { ascii: latin, hAnsi: latin, eastAsia, cs: latin }
}

/** px → EMU (Word's unit for drawing positions): 1 px = 9525 EMU at 96 dpi. */
const EMU_PER_PX = 9525

const WRAP_TYPE = {
  square: TextWrappingType.SQUARE,
  tight: TextWrappingType.TIGHT,
  through: TextWrappingType.THROUGH,
  topBottom: TextWrappingType.TOP_AND_BOTTOM
} as const

const SIDE_ALIGN = {
  left: HorizontalPositionAlign.LEFT,
  center: HorizontalPositionAlign.CENTER,
  right: HorizontalPositionAlign.RIGHT
} as const

/**
 * Top / Middle / Bottom beside the text, as Word's vertical alignment to the line it's anchored
 * on (the paragraph's first line); otherwise an offset from the paragraph.
 */
function verticalPosition(vpos: string, y: number) {
  const align = { top: VerticalPositionAlign.TOP, middle: VerticalPositionAlign.CENTER, bottom: VerticalPositionAlign.BOTTOM }[vpos]
  return align
    ? { relative: VerticalPositionRelativeFrom.LINE, align }
    : { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: Math.round(y * EMU_PER_PX) }
}

/** An image as Word sees it: inline, or anchored to the paragraph with Word's matching wrap setting. */
export function imageRun(node: DocNode): ImageRun | null {
  const a = imageAttrs(node)
  const data = imageData(a.src)
  if (!data) return null
  const base = { type: data.type, data: data.bytes, transformation: { width: Math.round(a.width), height: Math.round(a.height) }, altText: { name: a.alt || 'image', description: a.alt || '', title: a.alt || '' } }
  if (a.wrap === 'inline') return new ImageRun(base)
  if (a.wrap === 'behind' || a.wrap === 'front') {
    return new ImageRun({
      ...base,
      floating: {
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.COLUMN, offset: Math.round(a.x * EMU_PER_PX) },
        verticalPosition: verticalPosition(a.vpos, a.y),
        wrap: { type: TextWrappingType.NONE },
        behindDocument: a.wrap === 'behind',
        allowOverlap: true
      }
    })
  }
  const side = a.wrap === 'topBottom' ? a.side : a.side === 'right' ? 'right' : 'left'
  return new ImageRun({
    ...base,
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.COLUMN, align: SIDE_ALIGN[side] },
      verticalPosition: a.wrap === 'topBottom' ? { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: 0 } : verticalPosition(a.vpos, 0),
      wrap: { type: WRAP_TYPE[a.wrap], side: TextWrappingSide.BOTH_SIDES },
      // The image's own gap to the text (Word's "Distance from text").
      margins: a.wrap === 'topBottom'
        ? { top: Math.round(a.margin * EMU_PER_PX), bottom: Math.round(a.margin * EMU_PER_PX), left: 0, right: 0 }
        : { top: 0, bottom: Math.round(a.margin * EMU_PER_PX), left: Math.round(a.margin * EMU_PER_PX), right: Math.round(a.margin * EMU_PER_PX) },
      allowOverlap: false
    }
  })
}

/** Style ids written for the editor's quotes, code blocks and inline code (read back by the importer). */
export const QUOTE_STYLE = 'Quote'
export const CODE_STYLE = 'Code'
export const INLINE_CODE_STYLE = 'InlineCode'
const CODE_FONT = 'Consolas'

type RunOptions = ConstructorParameters<typeof TextRun>[0] & object

/** Text with tabs and line breaks (code blocks keep newlines in their text) as Word runs. */
function textRuns(text: string, opts: Exclude<RunOptions, string>): TextRun[] {
  const out: TextRun[] = []
  for (const part of text.split(/(\t|\n)/)) {
    if (part === '\n') out.push(new TextRun({ ...opts, text: '', break: 1 }))
    else if (part === '\t') out.push(new TextRun({ ...opts, children: [new Tab()] }))
    else if (part) out.push(new TextRun({ ...opts, text: part }))
  }
  return out
}

function runs(block: Block): (TextRun | ImageRun)[] {
  const out: (TextRun | ImageRun)[] = []
  for (const n of block.node.content ?? []) {
    if (n.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }))
      continue
    }
    if (n.type === 'image') {
      const run = imageRun(n)
      if (run) out.push(run)
      continue
    }
    if (n.type !== 'text') continue
    const s = runStyle(n)
    // Code takes its font from the Code / InlineCode styles.
    const code = s.code && block.type !== 'codeBlock'
    const font = block.type === 'codeBlock' || code ? null : s.font
    out.push(
      ...textRuns(n.text ?? '', {
        style: code ? INLINE_CODE_STYLE : undefined,
        bold: s.bold || undefined,
        italics: s.italic || undefined,
        underline: s.underline ? {} : undefined,
        strike: s.strike || undefined,
        font: font ? wordFont(font) : undefined,
        size: s.sizePt ? Math.round(s.sizePt * 2) : undefined
      })
    )
  }
  return out
}

function toParagraphs(blocks: Block[]): Paragraph[] {
  const paragraphs: Paragraph[] = []
  // Each ordered list gets its own numbering instance so numbers restart per list.
  // Tracked per nesting depth so a nested list doesn't steal its parent's numbering.
  let nextInstance = 0
  const instanceAtDepth: number[] = []

  for (const b of blocks) {
    if (b.type === 'horizontalRule') {
      paragraphs.push(
        new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } }
        })
      )
      continue
    }

    const level = Math.max(0, b.listDepth - 1)
    let numbering: { reference: string; level: number; instance?: number } | undefined
    let indent: { left: number } | undefined
    if (b.listDepth > 0 && b.listMarker) {
      if (b.listType === 'ordered') {
        if (b.listNumber === 1 || instanceAtDepth[b.listDepth] === undefined) {
          instanceAtDepth[b.listDepth] = ++nextInstance
        }
        numbering = { reference: 'ordered', level, instance: instanceAtDepth[b.listDepth] }
      } else {
        numbering = { reference: 'bullet', level }
      }
    } else if (b.listDepth > 0) {
      indent = { left: 720 * b.listDepth }
    }
    if (b.quoteDepth > 0) indent = { left: (indent?.left ?? 0) + 720 * b.quoteDepth }

    paragraphs.push(
      new Paragraph({
        children: runs(b),
        heading: b.type === 'heading' ? HEADINGS[b.headingLevel - 1] : undefined,
        style: b.type === 'codeBlock' ? CODE_STYLE : b.type !== 'heading' && b.quoteDepth > 0 && !numbering ? QUOTE_STYLE : undefined,
        alignment: b.align ? ALIGN[b.align] : undefined,
        numbering,
        indent,
        spacing: { after: 120 }
      })
    )
  }
  return paragraphs
}

function listLevels(format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (i: number) => string) {
  return Array.from({ length: 6 }, (_, i) => ({
    level: i,
    format,
    text: text(i),
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } }
  }))
}

export function docToDocxDocument(doc: DocNode): Document {
  return new Document({
    styles: {
      default: {
        document: {
          run: { font: wordFont(null), size: DEFAULT_SIZE_PT * 2 }
        }
      },
      paragraphStyles: [
        { id: QUOTE_STYLE, name: 'Quote', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { color: '444444' } },
        { id: CODE_STYLE, name: 'Code', basedOn: 'Normal', quickFormat: true, run: { font: wordFont(CODE_FONT), size: 20 }, paragraph: { spacing: { after: 0 } } }
      ],
      characterStyles: [{ id: INLINE_CODE_STYLE, name: 'Inline Code', basedOn: 'DefaultParagraphFont', run: { font: wordFont(CODE_FONT) } }]
    },
    numbering: {
      config: [
        { reference: 'bullet', levels: listLevels(LevelFormat.BULLET, (i) => ['•', '◦', '▪'][i % 3]) },
        { reference: 'ordered', levels: listLevels(LevelFormat.DECIMAL, (i) => `%${i + 1}.`) }
      ]
    },
    sections: [{ children: toParagraphs(flattenBlocks(doc)) }]
  })
}

/** The gap of each in-line picture, in the order they're written. */
function inlineGaps(doc: DocNode): number[] {
  const gaps: number[] = []
  for (const b of flattenBlocks(doc)) {
    for (const n of b.node.content ?? []) {
      if (n.type !== 'image') continue
      const a = imageAttrs(n)
      if (a.wrap === 'inline' && imageData(a.src)) gaps.push(a.margin)
    }
  }
  return gaps
}

/**
 * The docx library always writes 0 as an in-line picture's distance from text; write the image's
 * margin there instead, so it comes back when the file is opened again.
 */
async function withInlineGaps(bytes: Uint8Array, doc: DocNode): Promise<Uint8Array> {
  const gaps = inlineGaps(doc)
  if (!gaps.some((g) => g > 0)) return bytes
  const zip = await JSZip.loadAsync(bytes)
  const part = zip.file('word/document.xml')
  if (!part) return bytes
  let i = 0
  const xml = (await part.async('string')).replace(/<wp:inline distT="0" distB="0" distL="0" distR="0">/g, (m) => {
    const emu = Math.round((gaps[i++] ?? 0) * EMU_PER_PX)
    return emu > 0 ? `<wp:inline distT="${emu}" distB="${emu}" distL="${emu}" distR="${emu}">` : m
  })
  zip.file('word/document.xml', xml)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export async function docToDocxBuffer(doc: DocNode): Promise<Buffer> {
  return Buffer.from(await docToDocxBytes(doc))
}

/** Same as docToDocxBuffer, but works in the browser/webview too. */
export async function docToDocxBytes(doc: DocNode): Promise<Uint8Array> {
  return withInlineGaps(new Uint8Array(await Packer.toArrayBuffer(docToDocxDocument(doc))), doc)
}
