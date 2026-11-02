import type { DocNode } from '../types'
import { imageAttrs, imageData } from './images'
import {
  Block,
  DEFAULT_CJK_FONT,
  DEFAULT_FONT,
  DEFAULT_SIZE_PT,
  HEADING_SIZES_PT,
  flattenBlocks,
  hasCjk,
  isCjkFont,
  runStyle
} from './common'

/**
 * Escapes text for RTF. ASCII is written as-is (with \ { } escaped); everything else,
 * including Chinese, becomes \uN? with N as a signed 16-bit value (surrogate pairs for
 * characters outside the BMP), which Word and WordPad decode regardless of code page.
 */
export function escapeRtf(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const ch = text[i]
    if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch
    else if (ch === '\n') out += '\\line '
    else if (ch === '\t') out += '\\tab '
    else if (code >= 0x20 && code < 0x80) out += ch
    else if (code < 0x20) continue
    else out += `\\u${code > 32767 ? code - 65536 : code}?`
  }
  return out
}

/**
 * An embedded PNG/JPEG picture. RTF picture wrapping isn't widely supported, so images are
 * placed in line with the text (sizes in twips: 15 per px).
 */
export function rtfPicture(node: DocNode): string {
  const a = imageAttrs(node)
  const data = imageData(a.src)
  if (!data) return ''
  let hex = ''
  for (let i = 0; i < data.bytes.length; i++) {
    hex += data.bytes[i].toString(16).padStart(2, '0')
    if (i % 64 === 63) hex += '\n'
  }
  const blip = data.type === 'png' ? '\\pngblip' : '\\jpegblip'
  const w = Math.round(a.width)
  const h = Math.round(a.height)
  return `{\\pict${blip}\\picw${w}\\pich${h}\\picwgoal${w * 15}\\pichgoal${h * 15}\n${hex}}`
}

class FontTable {
  private fonts: string[] = []

  constructor() {
    this.index(DEFAULT_FONT)
    this.index(DEFAULT_CJK_FONT)
  }

  index(font: string): number {
    let i = this.fonts.indexOf(font)
    if (i < 0) {
      this.fonts.push(font)
      i = this.fonts.length - 1
    }
    return i
  }

  toRtf(): string {
    const entries = this.fonts.map((f, i) => {
      // 134 = GB2312 charset, so Word picks a Chinese-capable font for East Asian text.
      const charset = isCjkFont(f) ? 134 : 0
      return `{\\f${i}\\fnil\\fcharset${charset} ${escapeRtf(f)};}`
    })
    return `{\\fonttbl${entries.join('')}}`
  }
}

function paragraphProps(b: Block): string {
  let props = '\\pard\\plain'
  const align = { center: '\\qc', right: '\\qr', justify: '\\qj' }[b.align ?? ''] ?? '\\ql'
  props += align
  const indentTw = (b.listDepth * 360 + b.quoteDepth * 720)
  if (indentTw) props += `\\li${indentTw}`
  if (b.listDepth > 0 && b.listMarker) props += '\\fi-360'
  props += b.type === 'heading' ? '\\sb240\\sa120' : '\\sa120'
  return props
}

export function docToRtf(doc: DocNode): string {
  const fonts = new FontTable()
  const body: string[] = []

  for (const b of flattenBlocks(doc)) {
    if (b.type === 'horizontalRule') {
      body.push('\\pard\\plain\\brdrb\\brdrs\\brdrw10\\brsp20\\sa120\\par')
      continue
    }
    let para = paragraphProps(b)
    const baseSize = b.type === 'heading' ? HEADING_SIZES_PT[b.headingLevel - 1] : DEFAULT_SIZE_PT
    const baseBold = b.type === 'heading'

    if (b.listDepth > 0 && b.listMarker) {
      const marker = b.listType === 'ordered' ? `${b.listNumber}.` : '•'
      para += `{\\f${fonts.index(DEFAULT_FONT)}\\fs${baseSize * 2} ${escapeRtf(marker)}\\tab}`
    }

    for (const n of b.node.content ?? []) {
      if (n.type === 'hardBreak') {
        para += '\\line '
        continue
      }
      if (n.type === 'image') {
        para += rtfPicture(n)
        continue
      }
      if (n.type !== 'text') continue
      const s = runStyle(n)
      const text = n.text ?? ''
      let font = s.font ?? (b.type === 'codeBlock' || s.code ? 'Consolas' : DEFAULT_FONT)
      if (!s.font && hasCjk(text)) font = DEFAULT_CJK_FONT
      const size = s.sizePt ?? baseSize
      let codes = `\\f${fonts.index(font)}\\fs${Math.round(size * 2)}`
      if (s.bold || baseBold) codes += '\\b'
      if (s.italic) codes += '\\i'
      if (s.underline) codes += '\\ul'
      if (s.strike) codes += '\\strike'
      para += `{${codes} ${escapeRtf(text)}}`
    }
    body.push(para + '\\par')
  }

  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1${fonts.toRtf()}\n\\viewkind4\n${body.join('\n')}\n}`
}
