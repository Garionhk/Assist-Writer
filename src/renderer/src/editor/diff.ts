/**
 * Word-level text diff, used to carry formatting from the original text over to an AI rewrite.
 * English splits into words, spaces and punctuation; Chinese (no spaces) splits per character.
 */

export interface DiffOp {
  type: 'equal' | 'delete' | 'insert'
  /** Character range in the old text (empty for inserts). */
  oldStart: number
  oldEnd: number
  /** Character range in the new text (empty for deletes). */
  newStart: number
  newEnd: number
}

// Order matters: a Chinese character is always its own token; other letters/digits form words.
const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\u3000-\\u303F\\uFF00-\\uFFEF'
const TOKEN = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}_'’-])+|\\s+|[\\s\\S]`, 'gu')

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/** Largest diff (old tokens × new tokens) solved exactly; bigger ones only match the common start and end. */
const MAX_CELLS = 4_000_000

export function diffText(oldText: string, newText: string): DiffOp[] {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const aOff = offsets(a)
  const bOff = offsets(b)

  // Common prefix and suffix are cheap and cover most of a light edit.
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++

  const tokenOps: { type: DiffOp['type']; ai: number; bi: number; n: number }[] = []
  const push = (type: DiffOp['type'], ai: number, bi: number, n: number) => {
    if (n <= 0) return
    const last = tokenOps[tokenOps.length - 1]
    if (last && last.type === type && last.ai + (type === 'insert' ? 0 : last.n) === ai && last.bi + (type === 'delete' ? 0 : last.n) === bi) last.n += n
    else tokenOps.push({ type, ai, bi, n })
  }

  push('equal', 0, 0, pre)
  const aMid = a.slice(pre, a.length - suf)
  const bMid = b.slice(pre, b.length - suf)
  if (aMid.length * bMid.length <= MAX_CELLS) {
    // Longest common subsequence, then walk it forwards.
    const n = aMid.length
    const m = bMid.length
    const lcs = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          aMid[i] === bMid[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && aMid[i] === bMid[j]) {
        push('equal', pre + i, pre + j, 1)
        i++
        j++
      } else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1])) {
        // Deletions first, so a reworded part reads as "delete old, insert new".
        push('delete', pre + i, pre + j, 1)
        i++
      } else {
        push('insert', pre + i, pre + j, 1)
        j++
      }
    }
  } else {
    push('delete', pre, pre, aMid.length)
    push('insert', pre + aMid.length, pre, bMid.length)
  }
  push('equal', a.length - suf, b.length - suf, suf)

  return tokenOps.map((op) => ({
    type: op.type,
    oldStart: aOff[op.ai],
    oldEnd: op.type === 'insert' ? aOff[op.ai] : aOff[op.ai + op.n],
    newStart: bOff[op.bi],
    newEnd: op.type === 'delete' ? bOff[op.bi] : bOff[op.bi + op.n]
  }))
}

/** Character offset where each token starts (plus the total length at the end). */
function offsets(tokens: string[]): number[] {
  const out = [0]
  for (const t of tokens) out.push(out[out.length - 1] + t.length)
  return out
}
