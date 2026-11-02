import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import type { DocNode } from '../types'
import { docToRtf, escapeRtf } from './rtf'
import { docToMarkdown } from './markdown'
import { docToText, docToTextBuffer } from './text'
import { docToDocxBuffer } from './docx'
import { fontSizeToPt, cleanFontFamily } from './common'

const text = (t: string, marks: DocNode['marks'] = []): DocNode => ({ type: 'text', text: t, marks })
const para = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })

const sample: DocNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [text('Title 标题')] },
    para(
      text('Hello '),
      text('bold', [{ type: 'bold' }]),
      text(' and '),
      text('中文', [{ type: 'textStyle', attrs: { fontFamily: 'KaiTi', fontSize: '14pt' } }]),
      text(' under', [{ type: 'underline' }])
    ),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para(text('one'))] },
        { type: 'listItem', content: [para(text('two'))] }
      ]
    },
    {
      type: 'orderedList',
      attrs: { start: 1 },
      content: [
        { type: 'listItem', content: [para(text('first'))] },
        { type: 'listItem', content: [para(text('second'))] }
      ]
    }
  ]
}

describe('common', () => {
  it('parses font sizes and families', () => {
    expect(fontSizeToPt('12pt')).toBe(12)
    expect(fontSizeToPt('16px')).toBe(12)
    expect(fontSizeToPt('10.5pt')).toBe(10.5)
    expect(cleanFontFamily('"Microsoft YaHei", sans-serif')).toBe('Microsoft YaHei')
  })
})

describe('rtf', () => {
  it('escapes Chinese as signed unicode and RTF control characters', () => {
    expect(escapeRtf('中')).toBe('\\u20013?')
    expect(escapeRtf('{a\\b}')).toBe('\\{a\\\\b\\}')
    // Outside the BMP: surrogate pair, each written as a signed 16-bit value.
    expect(escapeRtf('😀')).toBe('\\u-10179?\\u-8704?')
  })

  it('writes a font table with a GB2312 charset for Chinese fonts and run formatting', () => {
    const rtf = docToRtf(sample)
    expect(rtf.startsWith('{\\rtf1')).toBe(true)
    expect(rtf).toMatch(/\\fcharset134 KaiTi;/)
    expect(rtf).toMatch(/\\fcharset134 Microsoft YaHei;/)
    expect(rtf).toContain('\\b bold}')
    expect(rtf).toContain('\\fs28 \\u20013?\\u25991?}')
    expect(rtf).toContain('\\ul  under}')
    // Pure ASCII output.
    expect(/^[\x00-\x7f]*$/.test(rtf)).toBe(true)
  })
})

describe('markdown', () => {
  it('converts headings, marks and lists', () => {
    const md = docToMarkdown(sample)
    expect(md).toContain('# Title 标题')
    expect(md).toContain('Hello **bold** and 中文 <u>under</u>')
    expect(md).toContain('- one\n- two')
    expect(md).toContain('1. first\n2. second')
  })

  it('escapes text that would otherwise become Markdown', () => {
    const md = docToMarkdown({ type: 'doc', content: [para(text('1. not a list *star*'))] })
    expect(md).toBe('1\\. not a list \\*star\\*\n')
  })
})

describe('text', () => {
  it('outputs plain text with list markers and CRLF line endings', () => {
    expect(docToText(sample)).toBe('Title 标题\r\nHello bold and 中文 under\r\n• one\r\n• two\r\n1. first\r\n2. second\r\n')
  })

  it('starts with a UTF-8 BOM', () => {
    const buf = docToTextBuffer(sample)
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })
})

describe('docx', () => {
  it('produces a Word document with East Asian fonts and formatting', async () => {
    const buf = await docToDocxBuffer(sample)
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('w:eastAsia="KaiTi"')
    expect(xml).toContain('<w:sz w:val="28"/>')
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:u w:val="single"/>')
    expect(xml).toContain('中文')
    expect(xml).toContain('Heading1')
    const styles = await zip.file('word/styles.xml')!.async('string')
    expect(styles).toContain('w:eastAsia="Microsoft YaHei"')
  })
})
