import type { DocNode } from '../types'

export const DEFAULT_FONT = 'Calibri'
export const DEFAULT_CJK_FONT = 'Microsoft YaHei'
export const DEFAULT_SIZE_PT = 12

/** Font sizes (pt) used for heading levels 1-6. */
export const HEADING_SIZES_PT = [24, 20, 16, 14, 12, 12]

const CJK_FONTS = new Set([
  'Microsoft YaHei',
  'Microsoft JhengHei',
  'SimSun',
  'SimHei',
  'KaiTi',
  'FangSong',
  'DengXian',
  'NSimSun',
  'PMingLiU',
  'MingLiU'
])

export function isCjkFont(font: string): boolean {
  return CJK_FONTS.has(font)
}

export function hasCjk(text: string): boolean {
  return /[⺀-鿿豈-﫿＀-￯　-〿]/.test(text)
}

/** Strips CSS quoting and fallbacks: `"Microsoft YaHei", sans-serif` → `Microsoft YaHei`. */
export function cleanFontFamily(value: string | null | undefined): string | null {
  if (!value) return null
  const first = value.split(',')[0].trim().replace(/^["']|["']$/g, '')
  return first || null
}

/** Converts a CSS font-size (`12pt`, `16px`) to points. */
export function fontSizeToPt(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^([\d.]+)\s*(pt|px)?$/i.exec(value.trim())
  if (!m) return null
  const n = parseFloat(m[1])
  return m[2]?.toLowerCase() === 'px' ? Math.round(n * 0.75 * 2) / 2 : n
}

export interface RunStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  font: string | null
  sizePt: number | null
}

export function runStyle(node: DocNode): RunStyle {
  const style: RunStyle = {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    font: null,
    sizePt: null
  }
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        style.bold = true
        break
      case 'italic':
        style.italic = true
        break
      case 'underline':
        style.underline = true
        break
      case 'strike':
        style.strike = true
        break
      case 'code':
        style.code = true
        break
      case 'textStyle':
        style.font = cleanFontFamily(mark.attrs?.fontFamily) ?? style.font
        style.sizePt = fontSizeToPt(mark.attrs?.fontSize) ?? style.sizePt
        break
    }
  }
  return style
}

/** Plain text of a node, with hard breaks as newlines. */
export function nodeText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(nodeText).join('')
}

/** A text block flattened out of the tree, with the list/quote context it sits in. */
export interface Block {
  node: DocNode
  /** paragraph | heading | codeBlock | horizontalRule */
  type: string
  headingLevel: number
  align: string | null
  /** List nesting depth (0 = not in a list). */
  listDepth: number
  listType: 'bullet' | 'ordered' | null
  /** Number for ordered list items; only set on the first paragraph of an item. */
  listNumber: number | null
  /** True for the first paragraph in a list item (where the bullet goes). */
  listMarker: boolean
  quoteDepth: number
}

/** Walks the document and returns its text blocks in order. */
export function flattenBlocks(doc: DocNode): Block[] {
  const blocks: Block[] = []

  const walk = (
    nodes: DocNode[],
    ctx: { listDepth: number; listType: Block['listType']; quoteDepth: number }
  ): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'paragraph':
        case 'heading':
        case 'codeBlock':
        case 'horizontalRule':
          blocks.push({
            node,
            type: node.type,
            headingLevel: node.type === 'heading' ? (node.attrs?.level ?? 1) : 0,
            align: node.attrs?.textAlign ?? null,
            listDepth: ctx.listDepth,
            listType: ctx.listType,
            listNumber: null,
            listMarker: false,
            quoteDepth: ctx.quoteDepth
          })
          break
        case 'bulletList':
        case 'orderedList': {
          const listType = node.type === 'bulletList' ? 'bullet' : 'ordered'
          let n = node.attrs?.start ?? 1
          for (const item of node.content ?? []) {
            const start = blocks.length
            walk(item.content ?? [], { ...ctx, listDepth: ctx.listDepth + 1, listType })
            const first = blocks[start]
            if (first) {
              first.listMarker = true
              if (listType === 'ordered') first.listNumber = n
            }
            n++
          }
          break
        }
        case 'blockquote':
          walk(node.content ?? [], { ...ctx, quoteDepth: ctx.quoteDepth + 1 })
          break
        default:
          if (node.content) walk(node.content, ctx)
      }
    }
  }

  walk(doc.content ?? [], { listDepth: 0, listType: null, quoteDepth: 0 })
  return blocks
}
