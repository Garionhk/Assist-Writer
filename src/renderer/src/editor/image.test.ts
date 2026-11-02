import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import { EditorState } from '@tiptap/pm/state'
import { AiChange } from './aiChange'
import { Image, anchorAtParagraphStart, embedLinkedImages, imageStyle, rememberLink, rememberOutline, isSupportedImageSrc, type ImageAttrs } from './image'
import { OBJECT_CHAR, replaceFromTagged, replaceKeepingStyle, stripTags, textOf, toTagged } from './changes'
import { textBlocks } from '../ai/liveChecker'
import { docToDocxBuffer } from '../../../shared/export/docx'
import { docToRtf } from '../../../shared/export/rtf'
import { docToMarkdown } from '../../../shared/export/markdown'
import { docToText } from '../../../shared/export/text'
import type { DocNode } from '../../../shared/types'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const schema = getSchema([StarterKit, TextStyle, AiChange, Image])
const img = (over: Partial<ImageAttrs> = {}): DocNode => ({
  type: 'image',
  attrs: { src: PNG, link: '', alt: 'pic', width: 120, height: 80, wrap: 'inline', side: 'left', valign: 'bottom', vpos: 'free', margin: 12, x: 0, y: 0, ...over }
})
const para = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })
const text = (t: string): DocNode => ({ type: 'text', text: t })

function state(...content: DocNode[]): EditorState {
  return EditorState.create({ doc: schema.nodeFromJSON({ type: 'doc', content: [para(...content)] }), schema })
}
const images = (s: EditorState) => {
  const out: string[] = []
  s.doc.descendants((n, pos) => {
    if (n.type.name === 'image') out.push(`${n.attrs.wrap}@${pos}`)
  })
  return out
}

describe('image wrap styles (same in the editor and in PDF)', () => {
  const base: ImageAttrs = { src: PNG, link: '', alt: '', width: 120, height: 80, wrap: 'inline', side: 'left', valign: 'bottom', vpos: 'free', margin: 12, x: 10, y: 20 }
  const OPAQUE = 'data:image/jpeg;base64,AAAA'
  rememberOutline(PNG, 'data:image/png;base64,OUTLINE')
  rememberOutline(OPAQUE, '')
  it('gives every Word wrap mode its layout', () => {
    expect(imageStyle(base)).toContain('display:inline-block')
    expect(imageStyle({ ...base, wrap: 'square', side: 'right' })).toMatch(/^float:right;/)
    // Tight: the gap follows the outline (the polygon itself is made at layout time).
    expect(imageStyle({ ...base, wrap: 'tight' })).toContain('shape-margin:12px')
    // An image without transparent parts wraps like Square (its box), as in Word.
    expect(imageStyle({ ...base, src: OPAQUE, wrap: 'tight' })).not.toContain('shape-margin')
    expect(imageStyle({ ...base, wrap: 'through' })).toContain('shape-margin')
    expect(imageStyle({ ...base, wrap: 'square' })).not.toContain('shape-margin')
    // Floats sit above the following paragraphs so they can still be clicked.
    expect(imageStyle({ ...base, wrap: 'square' })).toContain('z-index:1')
    expect(imageStyle({ ...base, wrap: 'topBottom', side: 'center' })).toContain('margin:12px auto 12px auto;')
    expect(imageStyle({ ...base, wrap: 'topBottom', side: 'right' })).toContain('margin:12px 0 12px auto;')
    expect(imageStyle({ ...base, wrap: 'behind' })).toContain('position:absolute;left:10px;top:20px;z-index:-1')
    expect(imageStyle({ ...base, wrap: 'front' })).toContain('z-index:5')
  })

  it('puts the chosen gap between a wrapped image and the text', () => {
    expect(imageStyle({ ...base, wrap: 'square', margin: 20 })).toContain('margin:0 20px 20px 0;')
    expect(imageStyle({ ...base, wrap: 'square', side: 'right', margin: 20 })).toContain('margin:0 0 20px 20px;')
    expect(imageStyle({ ...base, wrap: 'tight', margin: 20 })).toContain('shape-margin:20px')
    expect(imageStyle({ ...base, wrap: 'topBottom', margin: 0 })).toContain('margin:0px auto 0px 0;') // left-aligned
    expect(imageStyle({ ...base, margin: 6 })).toContain('display:inline-block;vertical-align:bottom;margin:6px;') // in line: all sides
  })

  it('lines an in-line image up with the top, middle or bottom of its text line', () => {
    expect(imageStyle({ ...base, valign: 'top' })).toContain('vertical-align:top;')
    expect(imageStyle({ ...base, valign: 'middle' })).toContain('vertical-align:middle;')
    expect(imageStyle({ ...base, valign: 'nonsense' as never })).toContain('vertical-align:bottom;')
  })

  it('anchors wrapped images at the start of their paragraph, like Word (in line images stay put)', () => {
    let s = state(text('Inside the castle there was a wizard.'), img({ wrap: 'tight', side: 'right' }), text(' More '), img())
    const fixed = anchorAtParagraphStart(s.tr, s.doc, null)!
    s = s.apply(fixed)
    expect(images(s)).toEqual(['tight@1', 'inline@45'])
    expect(textOf(s.doc, 0, s.doc.content.size)).toBe(`${OBJECT_CHAR}Inside the castle there was a wizard. More ${OBJECT_CHAR}`)
    // Already anchored: nothing to do.
    expect(anchorAtParagraphStart(s.tr, s.doc, null)).toBeNull()
  })

  it('only accepts embedded PNG and JPEG images', () => {
    expect(isSupportedImageSrc(PNG)).toBe(true)
    expect(isSupportedImageSrc('data:image/jpeg;base64,AAAA')).toBe(true)
    expect(isSupportedImageSrc('https://example.com/a.png')).toBe(false)
    expect(isSupportedImageSrc('data:image/gif;base64,AAAA')).toBe(false)
  })
})

describe('images are never lost by AI changes', () => {
  it('counts an image as one character in the paragraph text', () => {
    const s = state(text('Hello '), img(), text(' world'))
    expect(textOf(s.doc, 0, s.doc.content.size)).toBe(`Hello ${OBJECT_CHAR} world`)
  })

  it('keeps an image in place when the rewrite keeps its spot', () => {
    let s = state(text('He go '), img(), text(' to school.'))
    const p = s.doc.firstChild!
    s = s.apply(replaceKeepingStyle(s.tr, 1, 1 + p.content.size, `He goes ${OBJECT_CHAR} to school.`, 'c'))
    expect(textOf(s.doc, 0, s.doc.content.size)).toBe(`He goes ${OBJECT_CHAR} to school.`)
    expect(images(s)).toEqual(['inline@9'])
  })

  it('puts an image back at the start of the paragraph if the new text dropped it', () => {
    let s = state(text('He go '), img({ wrap: 'square' }), text(' to school.'))
    const p = s.doc.firstChild!
    s = s.apply(replaceKeepingStyle(s.tr, 1, 1 + p.content.size, 'He goes to school.', 'c'))
    expect(images(s)).toEqual(['square@1'])
    expect(textOf(s.doc, 0, s.doc.content.size)).toBe(`${OBJECT_CHAR}He goes to school.`)
  })

  it('sends images as <imgN/> and puts them back where the model kept them', () => {
    let s = state(text('A cat '), img(), text(' sleeps.'))
    const p = s.doc.firstChild!
    const info = toTagged(s.doc, 1, 1 + p.content.size)
    expect(info.text).toBe('A cat <img1/> sleeps.')
    expect(stripTags('一隻貓 <img1/> 在睡覺。')).toBe(`一隻貓 ${OBJECT_CHAR} 在睡覺。`)
    s = s.apply(replaceFromTagged(s.tr, 1, 1 + p.content.size, '一隻貓 <img1/> 在睡覺。', info, 'c'))
    expect(textOf(s.doc, 0, s.doc.content.size)).toBe(`一隻貓 ${OBJECT_CHAR} 在睡覺。`)
  })

  it('keeps the image even when the model drops or invents placeholders', () => {
    for (const answer of ['A cat sleeps.', 'A <img7/> cat sleeps.', 'A cat <img1/><img1/> sleeps.']) {
      let s = state(text('A cat '), img(), text(' sleeps.'))
      const p = s.doc.firstChild!
      s = s.apply(replaceFromTagged(s.tr, 1, 1 + p.content.size, answer, toTagged(s.doc, 1, 1 + p.content.size), 'c'))
      expect(images(s)).toHaveLength(1)
    }
  })

  it('does not send image-only paragraphs to the AI', () => {
    const doc = schema.nodeFromJSON({ type: 'doc', content: [para(img()), para(text('Real text.'))] })
    expect(textBlocks(doc).map((b) => b.text)).toEqual(['Real text.'])
  })
})

describe('linked images', () => {
  it('shows a linked file and embeds it for export, leaving the document itself linked', async () => {
    rememberLink('C:\pics\cat.png', PNG)
    const linkedImg = img({ src: '', link: 'C:\pics\cat.png', wrap: 'square' })
    const json: DocNode = { type: 'doc', content: [para(text('A '), linkedImg)] }
    const out = await embedLinkedImages(json)
    expect(out.content![0].content![1].attrs).toMatchObject({ src: PNG, link: '', wrap: 'square' })
    expect(linkedImg.attrs!.link).toBe('C:\pics\cat.png') // the original is untouched
    // The editor/PDF HTML shows the file's contents but keeps the path.
    const html = schema.nodeFromJSON(linkedImg).type.spec.toDOM!(schema.nodeFromJSON(linkedImg)) as [string, Record<string, string>]
    expect(html[1]).toMatchObject({ src: PNG, 'data-link': 'C:\pics\cat.png' })
  })
})

describe('exporting images', () => {
  const doc = (...imgs: DocNode[]): DocNode => ({ type: 'doc', content: imgs.map((i) => para(text('Before '), i, text(' after.'))) })

  it('writes Word images inline or anchored with the matching wrap', async () => {
    const buf = await docToDocxBuffer(
      doc(img(), img({ wrap: 'square', side: 'right' }), img({ wrap: 'tight' }), img({ wrap: 'through' }), img({ wrap: 'topBottom', side: 'center' }), img({ wrap: 'behind', x: 30, y: 10 }), img({ wrap: 'front' }))
    )
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect((xml.match(/<wp:inline/g) ?? []).length).toBe(1)
    expect((xml.match(/<wp:anchor/g) ?? []).length).toBe(6)
    for (const tag of ['wp:wrapSquare', 'wp:wrapTight', 'wp:wrapThrough', 'wp:wrapTopAndBottom', 'wp:wrapNone']) expect(xml).toContain(tag)
    expect(xml).toContain('behindDoc="1"')
    expect(xml).toContain('<wp:align>right</wp:align>')
    expect(xml).toContain(`<wp:posOffset>${30 * 9525}</wp:posOffset>`)
    expect(Object.keys(zip.files).some((f) => f.startsWith('word/media/'))).toBe(true)
  })

  it('writes RTF pictures, Markdown data images, and skips images in plain text', () => {
    const d = doc(img())
    expect(docToRtf(d)).toMatch(/\{\\pict\\pngblip\\picw120\\pich80\\picwgoal1800\\pichgoal1200\n89504e47/)
    expect(docToMarkdown(d)).toContain(`![pic](${PNG})`)
    expect(docToText(d)).toBe('Before  after.\r\n')
  })
})
