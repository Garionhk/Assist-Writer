import { Mark, type Node as PMNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { diffText } from './diff'

/** Leaf inline nodes count as one character, matching their size in the doc: hard breaks… */
export const LEAF_CHAR = '\n'
/** …and objects such as images (Unicode "object replacement character"). */
export const OBJECT_CHAR = '￼'

const leafChar = (leaf: PMNode) => (leaf.type.name === 'hardBreak' ? LEAF_CHAR : OBJECT_CHAR)

/** Text of a doc range where every character maps to exactly one position. */
export function textOf(doc: PMNode, from: number, to: number): string {
  return doc.textBetween(from, to, undefined, leafChar)
}

/** Text for showing to the user (popups, review, history): images as a picture symbol. */
export function forDisplay(text: string): string {
  return text.split(OBJECT_CHAR).join('🖼')
}

/** Text for the AI: without image placeholders (the model has nothing to do with them). */
export function withoutObjects(text: string): string {
  return text.split(OBJECT_CHAR).join('')
}

/** Finds the span of text carrying the aiChange mark with this id. */
export function findChangeRange(doc: PMNode, changeId: string): { from: number; to: number } | null {
  let from = -1
  let to = -1
  doc.descendants((node, pos) => {
    if (!node.isText) return
    if (node.marks.some((m) => m.type.name === 'aiChange' && m.attrs.changeId === changeId)) {
      if (from < 0) from = pos
      to = pos + node.nodeSize
    }
  })
  return from < 0 ? null : { from, to }
}

/** Ids of all aiChange marks currently in the document. */
export function changeIdsInDoc(doc: PMNode): Set<string> {
  const ids = new Set<string>()
  doc.descendants((node) => {
    if (!node.isText) return
    for (const m of node.marks) if (m.type.name === 'aiChange' && m.attrs.changeId) ids.add(m.attrs.changeId)
  })
  return ids
}

/** One character of existing text with its formatting (aiChange marks left out). */
interface StyledChar {
  ch: string
  marks: readonly Mark[]
  /** The image (or other object) at this position, for OBJECT_CHAR. */
  node?: PMNode
}

const withoutAiChange = (marks: readonly Mark[]): readonly Mark[] => marks.filter((m) => m.type.name !== 'aiChange')

/** The characters in [from, to) with their formatting; hard breaks count as '\n'. */
function styledChars(doc: PMNode, from: number, to: number): StyledChar[] {
  const out: StyledChar[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const start = Math.max(from, pos) - pos
      const end = Math.min(to, pos + node.nodeSize) - pos
      const marks = withoutAiChange(node.marks)
      // Iterate UTF-16 units so offsets line up with document positions.
      for (let i = start; i < end; i++) out.push({ ch: node.text![i], marks })
    } else if (node.isLeaf && node.isInline) {
      const ch = leafChar(node)
      out.push({ ch, marks: withoutAiChange(node.marks), node: ch === OBJECT_CHAR ? node : undefined })
    }
    return true
  })
  return out
}

/** Marks present on every one of the given mark sets. */
function commonMarks(sets: (readonly Mark[])[]): readonly Mark[] {
  if (!sets.length) return []
  return sets[0].filter((m) => sets.every((s) => m.isInSet(s)))
}

/**
 * Works out the formatting for each character of `newText`, replacing `old`:
 * - text that stays the same keeps exactly its original formatting;
 * - a reworded part takes the formatting shared by the words it replaces;
 * - newly inserted text takes the formatting shared by the text on both sides of it.
 */
export function styleNewText(
  old: StyledChar[],
  newText: string,
  fallback: readonly Mark[]
): { marks: (readonly Mark[])[]; objects: (PMNode | undefined)[] } {
  const oldText = old.map((c) => c.ch).join('')
  const marks: (readonly Mark[])[] = new Array(newText.length)
  // Images that stay where they were (an unchanged OBJECT_CHAR) keep their node.
  const objects: (PMNode | undefined)[] = new Array(newText.length)
  const ops = diffText(oldText, newText)
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    if (op.type === 'equal') {
      for (let i = 0; i < op.newEnd - op.newStart; i++) {
        marks[op.newStart + i] = old[op.oldStart + i].marks
        objects[op.newStart + i] = old[op.oldStart + i].node
      }
    } else if (op.type === 'insert') {
      // A delete right before or after this insert means the text was reworded: use the replaced text's formatting.
      const del = [ops[k - 1], ops[k + 1]].find((o) => o?.type === 'delete')
      let m: readonly Mark[]
      if (del) {
        m = commonMarks(old.slice(del.oldStart, del.oldEnd).map((c) => c.marks))
      } else {
        const left = old[op.oldStart - 1]?.marks
        const right = old[op.oldStart]?.marks
        m = left && right ? commonMarks([left, right]) : (left ?? right ?? fallback)
      }
      for (let i = op.newStart; i < op.newEnd; i++) marks[i] = m
    }
  }
  return { marks, objects }
}

/**
 * Replaces [from, to) with `text` while keeping the original formatting wherever the text is
 * unchanged (see `styleNewText`). When `changeId` is given the new text is tagged with an
 * aiChange mark so the change can be found and undone later.
 */
export function replaceKeepingStyle(tr: Transaction, from: number, to: number, text: string, changeId: string | null): Transaction {
  const old = styledChars(tr.doc, from, to)
  const images = old.flatMap((c) => (c.node ? [c.node] : []))
  if (!text && !images.length) return tr.delete(from, to)
  const fallback = withoutAiChange(tr.doc.resolve(from).marks())
  const { marks, objects } = styleNewText(old, text, fallback)
  return tr.replaceWith(from, to, buildNodes(tr, text, marks, fallback, changeId, objects, images))
}

/**
 * Turns text plus per-character formatting into nodes: text runs, hard breaks for '\n', and
 * images for OBJECT_CHAR. Safety net: any of `originals` (the images that were in the replaced
 * range) that didn't make it into the new text is put back at the start, so an AI change can
 * never lose an image.
 */
function buildNodes(
  tr: Transaction,
  text: string,
  charMarks: (readonly Mark[])[],
  fallback: readonly Mark[],
  changeId: string | null,
  objects: (PMNode | undefined)[] = [],
  originals: PMNode[] = []
): PMNode[] {
  const schema = tr.doc.type.schema
  const aiMark = changeId ? schema.marks.aiChange.create({ changeId }) : null
  const used = new Set<PMNode>()
  // Group neighbouring characters with the same formatting into text nodes.
  const nodes: PMNode[] = []
  let run = ''
  let runMarks: readonly Mark[] = []
  const flush = () => {
    if (run) nodes.push(schema.text(run, aiMark ? aiMark.addToSet(runMarks) : runMarks))
    run = ''
  }
  for (let i = 0; i < text.length; i++) {
    const m = charMarks[i] ?? fallback
    if (text[i] === OBJECT_CHAR) {
      const obj = objects[i]
      if (obj && !used.has(obj)) {
        flush()
        nodes.push(obj)
        used.add(obj)
      }
      continue
    }
    if (text[i] === '\n' && schema.nodes.hardBreak) {
      flush()
      nodes.push(schema.nodes.hardBreak.create())
      continue
    }
    if (run && !Mark.sameSet(m, runMarks)) flush()
    if (!run) runMarks = m
    run += text[i]
  }
  flush()
  const missing = originals.filter((n) => !used.has(n))
  return [...missing, ...nodes]
}

// ---- Formatting carried by the AI itself ---------------------------------------------------
//
// When text is translated or freely rewritten, almost no words survive, so matching old and new
// words (styleNewText) can't place the formatting. Instead, differently-formatted words are sent
// to the model wrapped in numbered tags, <f1>like this</f1>, and the model puts the same tags
// around the corresponding words of its translation or rewrite.

// Images are sent as placeholders, <img1/>, which the model keeps at the matching place.
const TAG = /<(\/?)f(\d+)>|<img(\d+)\s*\/?>/g

/** Text of a range with its formatting expressed as <fN>…</fN> tags and images as <imgN/>. */
export interface TaggedText {
  /** The text with tags, as sent to the model. */
  text: string
  /** The formatting each tag number stands for. */
  styles: Map<number, readonly Mark[]>
  /** Formatting shared by the whole range; applied to all new text, so it needs no tags. */
  base: readonly Mark[]
  /** The images in the range; <img1/> is objects[0]. */
  objects: PMNode[]
}

/** Plain text of a tagged answer: formatting tags removed, image placeholders as OBJECT_CHAR. */
export function stripTags(text: string): string {
  return text.replace(TAG, (_m, _close, _f, img) => (img ? OBJECT_CHAR : ''))
}

export function toTagged(doc: PMNode, from: number, to: number): TaggedText {
  const chars = styledChars(doc, from, to)
  const base = commonMarks(chars.filter((c) => !c.node).map((c) => c.marks))
  const styles = new Map<number, readonly Mark[]>()
  const objects: PMNode[] = []
  const idFor = (marks: readonly Mark[]): number | null => {
    if (Mark.sameSet(marks, base)) return null
    for (const [id, m] of styles) if (Mark.sameSet(m, marks)) return id
    styles.set(styles.size + 1, marks)
    return styles.size
  }
  let text = ''
  let i = 0
  while (i < chars.length) {
    if (chars[i].node) {
      objects.push(chars[i].node!)
      text += `<img${objects.length}/>`
      i++
      continue
    }
    let j = i
    while (j < chars.length && !chars[j].node && Mark.sameSet(chars[j].marks, chars[i].marks)) j++
    const run = chars.slice(i, j).map((c) => c.ch).join('')
    const id = idFor(chars[i].marks)
    text += id === null ? run : `<f${id}>${run}</f${id}>`
    i = j
  }
  return { text, styles, base, objects }
}

/**
 * Reads the model's tagged output back into plain text plus per-character formatting and the
 * images at their placeholders. Returns null when the formatting tags are broken (unknown
 * number, unclosed or crossed tags); unknown image placeholders are just skipped.
 */
export function fromTagged(
  tagged: string,
  info: TaggedText
): { text: string; marks: (readonly Mark[])[]; objects: (PMNode | undefined)[] } | null {
  const open: number[] = []
  let text = ''
  const marks: (readonly Mark[])[] = []
  const objects: (PMNode | undefined)[] = []
  let last = 0
  const current = () => {
    let m: readonly Mark[] = info.base
    for (const id of open) for (const mark of info.styles.get(id)!) m = mark.addToSet(m)
    return m
  }
  const pushText = (s: string) => {
    const m = current()
    for (const ch of s.split('')) {
      if (ch === OBJECT_CHAR) continue // stray placeholder characters from the model
      text += ch
      marks.push(m)
      objects.push(undefined)
    }
  }
  for (const match of tagged.matchAll(TAG)) {
    pushText(tagged.slice(last, match.index))
    last = match.index! + match[0].length
    if (match[3]) {
      const obj = info.objects[Number(match[3]) - 1]
      if (obj) {
        text += OBJECT_CHAR
        marks.push(info.base)
        objects.push(obj)
      }
      continue
    }
    const id = Number(match[2])
    if (!info.styles.has(id)) return null
    if (match[1]) {
      if (open[open.length - 1] !== id) return null
      open.pop()
    } else {
      open.push(id)
    }
  }
  pushText(tagged.slice(last))
  return open.length ? null : { text, marks, objects }
}

/**
 * Replaces [from, to) with the model's tagged output, giving each word the formatting its tag
 * stands for and putting images back at their placeholders. Falls back to word matching
 * (replaceKeepingStyle) when the original had nothing tagged, or when the model broke or
 * dropped all the tags. Either way, images are never lost (see buildNodes).
 */
export function replaceFromTagged(tr: Transaction, from: number, to: number, tagged: string, info: TaggedText, changeId: string | null): Transaction {
  const hadTags = info.styles.size > 0 || info.objects.length > 0
  const parsed = hadTags && /<\/?f\d+>|<img\d+/.test(tagged) ? fromTagged(tagged, info) : null
  if (!parsed || !parsed.text) return replaceKeepingStyle(tr, from, to, stripTags(tagged), changeId)
  return tr.replaceWith(from, to, buildNodes(tr, parsed.text, parsed.marks, info.base, changeId, parsed.objects, info.objects))
}

/**
 * Restores the original content of a change. With the saved original (`beforeContent`) the
 * exact formatting comes back; otherwise unchanged words keep their current formatting.
 */
export function restoreOriginal(tr: Transaction, from: number, to: number, before: string, beforeContent?: unknown[]): Transaction {
  if (beforeContent?.length) {
    try {
      const schema = tr.doc.type.schema
      const nodes = beforeContent.map((json) => schema.nodeFromJSON(json))
      return tr.replaceWith(from, to, nodes)
    } catch {
      /* saved content doesn't fit the schema any more: fall back to plain text */
    }
  }
  return replaceKeepingStyle(tr, from, to, before, null)
}

/** The exact content of [from, to) as JSON, for undoing a change with its formatting. */
export function contentJson(doc: PMNode, from: number, to: number): unknown[] {
  return doc.slice(from, to).content.toJSON() ?? []
}

export interface UndoCheck {
  range: { from: number; to: number } | null
  current: string
  /** True when the user edited the text after the change was applied. */
  modified: boolean
}

export function checkUndo(doc: PMNode, changeId: string, after: string): UndoCheck {
  const range = findChangeRange(doc, changeId)
  if (!range) return { range: null, current: '', modified: false }
  const current = textOf(doc, range.from, range.to)
  return { range, current, modified: current !== after }
}
