// Import and export of document formats, done inside the UI so the desktop app and the web
// version share one implementation. The Rust side only reads and writes the bytes.
import type { AwdFile, DocNode, ExportFormat, OpenResult } from '../../shared/types'
import { docToDocxBytes } from '../../shared/export/docx'
import { docxToDoc } from '../../shared/import/docx'
import { docToMarkdown } from '../../shared/export/markdown'
import { docToRtf } from '../../shared/export/rtf'
import { docToTextBuffer } from '../../shared/export/text'

export const IMPORT_EXTENSIONS = ['awd', 'docx', 'md', 'markdown', 'txt']

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

function splitName(fileName: string): { name: string; ext: string } {
  const base = fileName.replace(/^.*[\\/]/, '')
  const dot = base.lastIndexOf('.')
  return dot > 0 ? { name: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() } : { name: base, ext: '' }
}

export function parseAwd(json: string): AwdFile {
  const data = JSON.parse(stripBom(json)) as AwdFile
  if (data.format !== 'assist-writer') throw new Error('Not an Assist Writer document.')
  return data
}

/** Turns the bytes of an opened file into something the editor can load. */
export async function importBytes(fileName: string, bytes: Uint8Array, path: string | null): Promise<OpenResult> {
  const { name, ext } = splitName(fileName)
  const text = () => stripBom(new TextDecoder('utf-8').decode(bytes))
  switch (ext) {
    case 'awd':
      return { kind: 'awd', path: path ?? '', data: parseAwd(text()) }
    case 'docx':
      return { kind: 'doc', name, content: await docxToDoc(bytes) }
    case 'md':
    case 'markdown':
      return { kind: 'markdown', name, text: text() }
    case 'txt':
      return { kind: 'text', name, text: text() }
    default:
      throw new Error(`Unsupported file type: .${ext || '?'}`)
  }
}

/** Exports every format except PDF (which is printed by the browser engine on the Rust side). */
export async function exportBytes(format: Exclude<ExportFormat, 'pdf'>, doc: DocNode): Promise<Uint8Array> {
  switch (format) {
    case 'docx':
      return docToDocxBytes(doc)
    case 'rtf':
      return new TextEncoder().encode(docToRtf(doc)) // RTF output is pure ASCII
    case 'md':
      return new TextEncoder().encode(docToMarkdown(doc))
    case 'txt':
      return docToTextBuffer(doc)
  }
}
