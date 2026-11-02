import { describe, expect, it } from 'vitest'
import { orderByCursor, splitBatchResult } from './liveChecker'
import { checkBatchMessages, checkBatchSchema, rewriteSchema } from './prompts'

const s = (original: string) => ({ original, suggestion: original + '!', reason: '', type: 'grammar' as const })

describe('batch checking', () => {
  it('splits a batch answer into one list per paragraph, by index', () => {
    const out = splitBatchResult(
      { paragraphs: [{ index: 2, suggestions: [s('c')] }, { index: 0, suggestions: [s('a')] }, { index: 1, suggestions: [] }] },
      3
    )
    expect(out.map((l) => l.map((x) => x.original))).toEqual([['a'], [], ['c']])
  })

  it('falls back to list position for bad indexes and tolerates missing entries', () => {
    const out = splitBatchResult({ paragraphs: [{ index: 99, suggestions: [s('a')] }, { index: -1, suggestions: [s('b')] }] }, 3)
    expect(out.map((l) => l.map((x) => x.original))).toEqual([['a'], ['b'], []])
    expect(splitBatchResult({}, 2)).toEqual([[], []])
  })

  it('numbers the paragraphs and fixes the answer length in the schema', () => {
    const msgs = checkBatchMessages(['First one.', '第二段。'], '', null)
    expect(msgs[1].content).toContain('[0] First one.')
    expect(msgs[1].content).toContain('[1] 第二段。')
    const schema = checkBatchSchema(2).properties.paragraphs
    expect([schema.minItems, schema.maxItems]).toEqual([2, 2])
    expect(rewriteSchema(5).properties.paragraphs.minItems).toBe(5)
  })
})

describe('orderByCursor', () => {
  const block = (pos: number, size: number) => ({ pos, node: { nodeSize: size } })

  it('puts the paragraph under the cursor first, then the nearest ones', () => {
    const blocks = [block(0, 10), block(10, 10), block(20, 10), block(30, 10)]
    expect(orderByCursor(blocks, 25).map((b) => b.pos)).toEqual([20, 10, 30, 0])
  })
})
