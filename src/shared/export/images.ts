import type { DocNode } from '../types'

/** Image attributes as stored in the document (see src/renderer/src/editor/image.ts). */
export interface ImageNodeAttrs {
  src: string
  /** Linked image file (desktop app). Exports resolve links to embedded data beforehand. */
  link: string
  alt?: string
  /** Gap between image and text (px). */
  margin: number
  width: number
  height: number
  wrap: 'inline' | 'square' | 'tight' | 'through' | 'topBottom' | 'behind' | 'front'
  side: 'left' | 'center' | 'right'
  /** Beside its paragraph's text (not in line / top-and-bottom), or free. */
  vpos: 'free' | 'top' | 'middle' | 'bottom'
  x: number
  y: number
}

export function imageAttrs(node: DocNode): ImageNodeAttrs {
  const a = node.attrs ?? {}
  return {
    src: String(a.src ?? ''),
    link: String(a.link ?? ''),
    alt: a.alt ?? '',
    margin: Number.isFinite(Number(a.margin)) ? Number(a.margin) : 12,
    width: Number(a.width) || 200,
    height: Number(a.height) || 150,
    wrap: a.wrap ?? 'inline',
    side: a.side ?? 'left',
    vpos: a.vpos === 'top' || a.vpos === 'middle' || a.vpos === 'bottom' ? a.vpos : 'free',
    x: Number(a.x) || 0,
    y: Number(a.y) || 0
  }
}

/** The bytes and type of an embedded (data URL) PNG or JPEG image, or null for anything else. */
export function imageData(src: string): { type: 'png' | 'jpg'; bytes: Uint8Array } | null {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(src)
  if (!m) return null
  const binary = atob(m[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { type: m[1].toLowerCase() === 'png' ? 'png' : 'jpg', bytes }
}
