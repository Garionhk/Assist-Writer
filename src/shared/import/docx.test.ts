import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import { Image } from '../../renderer/src/editor/image'
import { docToDocxBuffer } from '../export/docx'
import type { DocNode } from '../types'
import { docxToDoc } from './docx'
import { parseXml } from './xml'

// The editor's schema, as in App.tsx: the round trip is compared in its canonical JSON.
const schema = getSchema([StarterKit.configure({ link: false }), TextStyle, FontFamily, FontSize, TextAlign.configure({ types: ['heading', 'paragraph'] }), Image])
const canonical = (doc: DocNode) => schema.nodeFromJSON(doc).toJSON()

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const JPG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
const t = (text: string, ...marks: DocNode['marks'] & object): DocNode => (marks.length ? { type: 'text', text, marks } : { type: 'text', text })
const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })
const img = (over: Record<string, unknown> = {}): DocNode => ({
  type: 'image',
  attrs: { src: PNG, link: '', alt: 'pic', width: 120, height: 80, wrap: 'inline', side: 'left', margin: 12, x: 0, y: 0, ...over }
})
const font = (fontFamily: string) => ({ type: 'textStyle', attrs: { fontFamily } })
const size = (fontSize: string) => ({ type: 'textStyle', attrs: { fontSize } })
const item = (...content: DocNode[]): DocNode => ({ type: 'listItem', content })

const doc: DocNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [t('Title 標題')] },
    { type: 'heading', attrs: { level: 2 }, content: [t('Second level')] },
    p(
      t('Plain '),
      t('bold', { type: 'bold' }),
      t(' '),
      t('italic', { type: 'italic' }),
      t(' '),
      t('both', { type: 'underline' }, { type: 'strike' }),
      t(' '),
      t('Georgia', font('Georgia')),
      t(' '),
      t('big', size('16pt')),
      t(' '),
      t('Georgia 16', { type: 'textStyle', attrs: { fontFamily: 'Georgia', fontSize: '16pt' } }),
      t(' '),
      t('正黑體', font('Microsoft JhengHei')),
      t(' 中文 '),
      t('x = 1', { type: 'code' }),
      { type: 'hardBreak' },
      t('after\tTab')
    ),
    {
      type: 'bulletList',
      content: [
        item(p(t('one'))),
        item(p(t('two')), { type: 'orderedList', attrs: { start: 1 }, content: [item(p(t('two-a'))), item(p(t('two-b')))] }),
        item(p(t('three')), p(t('three, second paragraph')))
      ]
    },
    { type: 'orderedList', attrs: { start: 1 }, content: [item(p(t('first'))), item(p(t('second')))] },
    { type: 'blockquote', content: [p(t('A quote,')), p(t('two paragraphs.'))] },
    { type: 'codeBlock', attrs: { language: null }, content: [t('let a = 1\nlet b = 2')] },
    { type: 'horizontalRule' },
    p(img({ wrap: 'square', side: 'right', margin: 20 }), t('Text beside a square picture, and an inline one '), img({ src: JPG, alt: '' }), t('.')),
    p(img({ wrap: 'tight', vpos: 'top' }), t('Tight, top.')),
    p(img({ wrap: 'square', vpos: 'middle' }), t('Square, middle.')),
    p(img({ wrap: 'behind', vpos: 'bottom' }), t('Behind, bottom.')),
    p(img({ wrap: 'tight' }), t('Tight.')),
    p(img({ wrap: 'through', side: 'right', margin: 0 }), t('Through.')),
    p(img({ wrap: 'topBottom', side: 'center', margin: 8 }), t('Top and bottom.')),
    p(img({ wrap: 'behind', x: 30, y: 10 }), t('Behind.')),
    p(img({ wrap: 'front', x: -5, y: 40 }), t('In front.')),
    { type: 'paragraph' },
    { type: 'paragraph', attrs: { textAlign: 'justify' }, content: [t('Justified text.')] },
    // In-line pictures keep their own gap (none, small).
    p(t('Gaps: '), img({ margin: 0 }), t(' and '), img({ margin: 5 }))
  ]
}

describe('reading Word documents', () => {
  it('reopens a document saved as Word exactly as it was', async () => {
    const back = await docxToDoc(new Uint8Array(await docToDocxBuffer(doc)))
    expect(canonical(back)).toEqual(canonical(doc))
  })

  it('reads Word files from other programs: styles, theme fonts, lists, tables, changes, fields, notes and pictures', async () => {
    const zip = new JSZip()
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    zip.file('_rels/.rels', `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    zip.file(
      'word/_rels/document.xml.rels',
      `<Relationships>
        <Relationship Id="s" Type="http://x/styles" Target="styles.xml"/>
        <Relationship Id="n" Type="http://x/numbering" Target="numbering.xml"/>
        <Relationship Id="t" Type="http://x/theme" Target="theme/theme1.xml"/>
        <Relationship Id="f" Type="http://x/footnotes" Target="footnotes.xml"/>
        <Relationship Id="img" Type="http://x/image" Target="media/a.png"/>
        <Relationship Id="web" Type="http://x/hyperlink" Target="https://example.com" TargetMode="External"/>
      </Relationships>`
    )
    zip.file('word/media/a.png', Uint8Array.from(atob(PNG.split(',')[1]), (c) => c.charCodeAt(0)))
    zip.file(
      'word/theme/theme1.xml',
      `<a:theme xmlns:a="x"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Cambria"/><a:ea typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`
    )
    zip.file(
      'word/styles.xml',
      `<w:styles ${W}>
        <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
        <w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>
        <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
        <w:style w:type="paragraph" w:styleId="Emph"><w:name w:val="Emphasis Para"/><w:basedOn w:val="a"/><w:rPr><w:i/></w:rPr></w:style>
        <w:style w:type="paragraph" w:styleId="Q"><w:name w:val="Intense Quote"/><w:basedOn w:val="a"/></w:style>
      </w:styles>`
    )
    zip.file(
      'word/numbering.xml',
      `<w:numbering ${W}>
        <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
        <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
        <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
        <w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
      </w:numbering>`
    )
    zip.file(
      'word/footnotes.xml',
      `<w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> A note.</w:t></w:r></w:p></w:footnote></w:footnotes>`
    )
    const run = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
    zip.file(
      'word/document.xml',
      `<w:document ${W} xmlns:wp="wp" xmlns:a="a" xmlns:pic="pic"><w:body>
        <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr>${run('Heading in a localized style')}</w:p>
        <w:p>${run('Theme font &amp; size ')}${run('Times', '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>')}${run('細明體', '<w:rFonts w:eastAsia="PMingLiU"/>')}</w:p>
        <w:p><w:pPr><w:pStyle w:val="Emph"/><w:jc w:val="right"/></w:pPr>${run('Italic from the style')}${run(' not bold', '<w:b w:val="0"/>')}</w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run('bullet')}</w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>${run('five')}</w:p>
        <w:p><w:pPr><w:pStyle w:val="Q"/></w:pPr>${run('Quoted')}</w:p>
        <w:tbl><w:tr><w:tc><w:p>${run('A1')}</w:p></w:tc><w:tc><w:p>${run('B1')}</w:p></w:tc></w:tr></w:tbl>
        <w:p>${run('Kept ')}<w:ins>${run('inserted')}</w:ins><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del>${run(' ')}<w:hyperlink r:id="web">${run('link')}</w:hyperlink>${run(' page ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('7')}<w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:footnoteReference w:id="1"/></w:r>${run('hidden', '<w:vanish/>')}</w:p>
        <w:p><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="190500" distR="190500" behindDoc="0"><wp:positionH relativeFrom="column"><wp:posOffset>4000000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="952500" cy="476250"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Picture 1" descr="A dot"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="img"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>${run('Wrapped by a picture at the right.')}</w:p>
        <w:sectPr/>
      </w:body></w:document>`
    )
    const back = await docxToDoc(await zip.generateAsync({ type: 'uint8array' }))
    expect(canonical(back)).toEqual(
      canonical({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [t('Heading in a localized style')] },
          // Aptos (the theme font) and 11 pt are this file's defaults, so they're kept as marks.
          p(
            t('Theme font & size ', { type: 'textStyle', attrs: { fontFamily: 'Aptos', fontSize: '11pt' } }),
            t('Times', { type: 'textStyle', attrs: { fontFamily: 'Times New Roman', fontSize: '11pt' } }),
            t('細明體', { type: 'textStyle', attrs: { fontFamily: 'PMingLiU', fontSize: '11pt' } })
          ),
          {
            type: 'paragraph',
            attrs: { textAlign: 'right' },
            content: [
              t('Italic from the style', { type: 'italic' }, { type: 'textStyle', attrs: { fontFamily: 'Aptos', fontSize: '11pt' } }),
              t(' not bold', { type: 'italic' }, { type: 'textStyle', attrs: { fontFamily: 'Aptos', fontSize: '11pt' } })
            ]
          },
          { type: 'bulletList', content: [item(p(t('bullet', size11())))] },
          { type: 'orderedList', attrs: { start: 5 }, content: [item(p(t('five', size11())))] },
          { type: 'blockquote', content: [p(t('Quoted', size11()))] },
          // A table row: its cells separated by tabs.
          p(t('A1', size11()), t('\t'), t('B1', size11())),
          p(t('Kept inserted link page 7[1]', size11())),
          p(img({ alt: 'A dot', width: 100, height: 50, wrap: 'square', side: 'right', margin: 20 }), t('Wrapped by a picture at the right.', size11())),
          // Notes follow the text with their number.
          p(t('[1] '), t(' A note.', size11()))
        ]
      })
    )
  })

  it('refuses files that are not Word documents', async () => {
    await expect(docxToDoc(new TextEncoder().encode('not a zip'))).rejects.toThrow(/not a Word document/)
    const empty = new JSZip()
    empty.file('word/document.xml', '<w:document xmlns:w="w"/>')
    await expect(docxToDoc(await empty.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/no content/)
  })
})

function size11() {
  return { type: 'textStyle', attrs: { fontFamily: 'Aptos', fontSize: '11pt' } }
}

describe('the XML parser', () => {
  it('reads elements, attributes, entities, CDATA and keeps text spaces', () => {
    const x = parseXml(`<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y='&#x4E2D;'><b> sp </b><![CDATA[<raw>]]><c/></a>`)
    expect(x.name).toBe('a')
    expect(x.attrs).toEqual({ x: '1 & 2', y: '中' })
    expect(x.children).toEqual([{ name: 'b', attrs: {}, children: [' sp '] }, '<raw>', { name: 'c', attrs: {}, children: [] }])
  })
})
