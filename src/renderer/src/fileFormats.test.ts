import { describe, expect, it } from 'vitest'
import type { DocNode } from '../../shared/types'
import { exportBytes, importBytes } from './fileFormats'

const doc: DocNode = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: '你好世界' }] }
  ]
}

describe('fileFormats', () => {
  it('round-trips a document through Word: export to .docx, import it back', async () => {
    const bytes = await exportBytes('docx', doc)
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK') // a zip file
    const res = await importBytes('round-trip.docx', bytes, null)
    expect(res.kind).toBe('doc')
    if (res.kind !== 'doc') return
    expect(res.name).toBe('round-trip')
    expect(res.content).toMatchObject(doc)
  })

  it('exports text formats as bytes', async () => {
    const txt = await exportBytes('txt', doc)
    expect([...txt.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(await exportBytes('md', doc))).toContain('Hello **bold**')
    expect(new TextDecoder().decode(await exportBytes('rtf', doc))).toMatch(/^\{\\rtf1/)
  })

  it('imports .awd, Markdown and text (with a BOM) and rejects unknown types', async () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const awd = { format: 'assist-writer', version: 1, content: doc, history: [], ignored: [], createdAt: '', updatedAt: '' }
    const a = await importBytes('My doc.awd', enc('\uFEFF' + JSON.stringify(awd)), 'C:\\docs\\My doc.awd')
    expect(a).toMatchObject({ kind: 'awd', path: 'C:\\docs\\My doc.awd' })
    expect(await importBytes('notes.md', enc('# Title'), null)).toMatchObject({ kind: 'markdown', name: 'notes', text: '# Title' })
    expect(await importBytes('a.txt', enc('\uFEFFline'), null)).toMatchObject({ kind: 'text', text: 'line' })
    await expect(importBytes('x.pdf', enc(''), null)).rejects.toThrow('Unsupported')
    await expect(importBytes('bad.awd', enc('{"format":"other"}'), null)).rejects.toThrow('Not an Assist Writer')
  })
})
