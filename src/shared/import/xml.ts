// A small XML parser for reading Office files (well-formed XML from a zip). It works the same in
// the browser and in Node (tests), needs no DOM, and is bounded so a hostile file can't hang it.

export interface XmlEl {
  /** Qualified name as written, e.g. `w:p`. */
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}
export type XmlNode = XmlEl | string

/** Limits for one XML part. */
const MAX_DEPTH = 512
const MAX_NODES = 5_000_000

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e] ?? m
  })
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g

/** Parses an XML document and returns its root element. Throws on badly broken markup. */
export function parseXml(text: string): XmlEl {
  const root: XmlEl = { name: '#document', attrs: {}, children: [] }
  const stack: XmlEl[] = [root]
  let nodes = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const lt = text.indexOf('<', i)
    const end = lt < 0 ? n : lt
    if (end > i) {
      // Text is kept as is (the reader only looks at text inside elements like w:t).
      if (stack.length > 1) stack[stack.length - 1].children.push(decode(text.slice(i, end)))
    }
    if (lt < 0) break
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4)
      i = close < 0 ? n : close + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9)
      const t = text.slice(lt + 9, close < 0 ? n : close)
      stack[stack.length - 1].children.push(t)
      i = close < 0 ? n : close + 3
      continue
    }
    if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt + 2)
      i = close < 0 ? n : close + 2
      continue
    }
    if (text.startsWith('<!', lt)) {
      const close = text.indexOf('>', lt + 2)
      i = close < 0 ? n : close + 1
      continue
    }
    // A tag: find its end, skipping '>' inside quoted attribute values.
    let j = lt + 1
    let quote = ''
    while (j < n) {
      const ch = text[j]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      j++
    }
    if (j >= n) throw new Error('Broken XML: unterminated tag')
    const body = text.slice(lt + 1, j)
    i = j + 1
    if (body[0] === '/') {
      const name = body.slice(1).trim()
      // Pop to the matching element (lenient about stray end tags).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k
          break
        }
      }
      continue
    }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const sp = inner.search(/\s/)
    const name = sp < 0 ? inner : inner.slice(0, sp)
    const attrs: Record<string, string> = {}
    if (sp >= 0) {
      ATTR.lastIndex = 0
      const rest = inner.slice(sp)
      let m: RegExpExecArray | null
      while ((m = ATTR.exec(rest))) attrs[m[1]] = decode(m[3] ?? m[4] ?? '')
    }
    if (++nodes > MAX_NODES) throw new Error('This document is too large to open.')
    const el: XmlEl = { name, attrs, children: [] }
    stack[stack.length - 1].children.push(el)
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) throw new Error('This document is nested too deeply to open.')
      stack.push(el)
    }
  }
  const top = root.children.find((c): c is XmlEl => typeof c !== 'string')
  if (!top) throw new Error('Broken XML: no root element')
  return top
}

/** Child elements (optionally only those with a given name). */
export function kids(el: XmlEl | undefined, name?: string): XmlEl[] {
  if (!el) return []
  const out: XmlEl[] = []
  for (const c of el.children) if (typeof c !== 'string' && (!name || c.name === name)) out.push(c)
  return out
}

/** The first child element with this name. */
export function kid(el: XmlEl | undefined, name: string): XmlEl | undefined {
  if (!el) return undefined
  for (const c of el.children) if (typeof c !== 'string' && c.name === name) return c
  return undefined
}

/** A chain of first children: `path(el, 'w:pPr', 'w:jc')`. */
export function path(el: XmlEl | undefined, ...names: string[]): XmlEl | undefined {
  let cur = el
  for (const n of names) cur = kid(cur, n)
  return cur
}

/** A descendant with this name, the shallowest first. */
export function find(el: XmlEl | undefined, name: string): XmlEl | undefined {
  if (!el) return undefined
  const stack: XmlEl[] = [el]
  while (stack.length) {
    const cur = stack.pop()!
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]
      if (typeof c === 'string') continue
      if (c.name === name) return c
    }
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]
      if (typeof c !== 'string') stack.push(c)
    }
  }
  return undefined
}

/** All text inside an element. */
export function textOf(el: XmlEl): string {
  let s = ''
  for (const c of el.children) s += typeof c === 'string' ? c : textOf(c)
  return s
}
