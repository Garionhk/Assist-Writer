import type { DocNode } from '../types'
import { flattenBlocks, nodeText } from './common'

/** Plain text export: no formatting, Windows line endings, list markers kept for readability. */
export function docToText(doc: DocNode): string {
  const lines: string[] = []
  for (const b of flattenBlocks(doc)) {
    if (b.type === 'horizontalRule') {
      lines.push('----------')
      continue
    }
    const indent = '  '.repeat(Math.max(0, b.listDepth - 1))
    let prefix = ''
    if (b.listDepth > 0) {
      prefix = b.listMarker ? (b.listType === 'ordered' ? `${b.listNumber}. ` : '• ') : '  '
    }
    const text = nodeText(b.node)
    lines.push(indent + prefix + text.replace(/\n/g, '\r\n' + indent))
  }
  // The editor always keeps an empty last paragraph; don't export it as blank lines.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.join('\r\n') + '\r\n'
}

/** Text export bytes: UTF-8 with BOM so Notepad and older apps detect Chinese correctly. */
export function docToTextBuffer(doc: DocNode): Uint8Array {
  const body = new TextEncoder().encode(docToText(doc))
  const out = new Uint8Array(body.length + 3)
  out.set([0xef, 0xbb, 0xbf])
  out.set(body, 3)
  return out
}
