// Benchmarks Ollama models on real Assist Writer tasks (same prompts as the app).
//   npm run bench -- [model ...]        (no models: the default candidate list)
// Results: printed table + bench-results/<timestamp>/ (summary.md, results.json, raw outputs).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { chatDetailed, loadedModels, unloadModel, type ChatStats } from './lib/ollama'
import { loadSettings } from './lib/settings'
import {
  CHECK_SCHEMA,
  IMPROVE_SCHEMA,
  LIVE_CTX,
  checkBatchMessages,
  checkBatchSchema,
  checkMessages,
  improveMessages,
  parseJson,
  rewriteMessages,
  rewriteSchema
} from '../src/renderer/src/ai/prompts'
import type { ChatMessage } from '../src/shared/types'
import { splitBatchResult } from '../src/renderer/src/ai/liveChecker'

// Models to compare when none are given on the command line.
const DEFAULT_MODELS = ['qwen3.5:9b', 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL']

/** Test paragraphs with planted mistakes: a fix counts when `bad` is gone and `good` is present. */
interface Para {
  text: string
  fixes: { bad: string; good: string }[]
}

const PARAS: Para[] = [
  {
    text: 'He go to school every days and he like it very much.',
    fixes: [
      { bad: 'He go ', good: 'goes' },
      { bad: 'every days', good: 'every day' },
      { bad: 'he like ', good: 'like' } // "likes" contains "like"; checked together with bad
    ]
  },
  {
    text: 'Yesterday I buyed three apple from the market.',
    fixes: [
      { bad: 'buyed', good: 'bought' },
      { bad: 'three apple ', good: 'apples' }
    ]
  },
  {
    text: "She don't know where is the library.",
    fixes: [
      { bad: "She don't", good: "n't" },
      { bad: 'where is the library', good: 'library' }
    ]
  },
  { text: '我今天很高兴的去公园玩。', fixes: [{ bad: '高兴的去', good: '地' }] },
  { text: '他跑的非常快，大家都很佩服他的。', fixes: [{ bad: '跑的非常', good: '跑得' }] }
]
/** A correct paragraph: any grammar suggestion here is a false alarm. */
const CLEAN = 'The weather was pleasant, so we walked along the river after dinner.'
const IMPROVE_TEXT = 'The company did not pay the money it owed us for three months, so we stopped working on the project.'

const url = loadSettings().ollamaUrl
const ctx = { summary: '', before: '', after: '' }
const sec = (ns?: number) => (ns ? ns / 1e9 : 0)
const tps = (count?: number, ns?: number) => (count && ns ? count / sec(ns) : 0)

interface Suggestion {
  original: string
  suggestion: string
  type: string
}

function applySuggestions(text: string, list: Suggestion[]): string {
  let out = text
  for (const s of list) if (s.original && out.includes(s.original)) out = out.replace(s.original, s.suggestion)
  return out
}

function score(p: Para, corrected: string): number {
  return p.fixes.filter((f) => !corrected.includes(f.bad) && corrected.includes(f.good)).length
}

async function run(model: string, messages: ChatMessage[], schema: object, extra: { numCtx?: number; maxTokens?: number } = {}) {
  const t0 = Date.now()
  const { text, stats } = await chatDetailed(url, {
    requestId: `bench-${t0}`,
    model,
    messages,
    schema,
    temperature: 0.2,
    keepAlive: '10m',
    ...extra
  })
  return { text, stats, wallMs: Date.now() - t0 }
}

interface ModelResult {
  model: string
  error?: string
  loadSec: number
  gpuPct: number
  promptTps: number
  genTps: number
  check1Sec: number
  check3Sec: number
  batch3Sec: number
  batchFixed: number
  batchTotal: number
  checkFixed: number
  checkTotal: number
  falseAlarms: number
  improveSec: number
  rewriteSec: number
  rewriteFixed: number
  rewriteTotal: number
  rewriteParasOk: boolean
  jsonOk: number
  jsonTotal: number
}

async function benchModel(model: string, outDir: string): Promise<ModelResult> {
  const r: ModelResult = {
    model, loadSec: 0, gpuPct: 0, promptTps: 0, genTps: 0, check1Sec: 0, check3Sec: 0, batch3Sec: 0, batchFixed: 0, batchTotal: 0, checkFixed: 0, checkTotal: 0,
    falseAlarms: 0, improveSec: 0, rewriteSec: 0, rewriteFixed: 0, rewriteTotal: 0, rewriteParasOk: false, jsonOk: 0, jsonTotal: 0
  }
  const raw: Record<string, unknown> = {}
  const allStats: ChatStats[] = []
  const parse = <T>(text: string): T | null => {
    r.jsonTotal++
    try {
      const v = parseJson<T>(text)
      r.jsonOk++
      return v
    } catch {
      return null
    }
  }

  // Start cold: nothing loaded, so the first request measures the load time.
  for (const m of await loadedModels(url)) await unloadModel(url, m.name)

  console.log(`\n▶ ${model}`)
  // 1) Cold check of one paragraph (includes loading the model).
  const cold = await run(model, checkMessages(PARAS[0].text, ctx), CHECK_SCHEMA)
  r.loadSec = sec(cold.stats.load_duration)
  const loaded = (await loadedModels(url)).find((m) => m.name === model || model.endsWith(m.name) || m.name.endsWith(model))
  r.gpuPct = loaded && loaded.size ? Math.round((loaded.sizeVram / loaded.size) * 100) : 0
  console.log(`  loaded in ${r.loadSec.toFixed(1)} s, ${r.gpuPct}% on GPU`)

  // 2) Warm checks: each test paragraph on its own (how the app checks today).
  const checkOut: unknown[] = []
  let t3 = 0
  for (const [i, p] of PARAS.entries()) {
    const res = await run(model, checkMessages(p.text, ctx), CHECK_SCHEMA)
    allStats.push(res.stats)
    if (i === 0) r.check1Sec = res.wallMs / 1000
    if (i < 3) t3 += res.wallMs
    const list = parse<{ suggestions: Suggestion[] }>(res.text)?.suggestions ?? []
    const corrected = applySuggestions(p.text, list)
    r.checkFixed += score(p, corrected)
    r.checkTotal += p.fixes.length
    checkOut.push({ text: p.text, corrected, suggestions: list, sec: res.wallMs / 1000 })
  }
  r.check3Sec = t3 / 1000

  // Same 3 paragraphs in one batched request (how the app checks now).
  const three = PARAS.slice(0, 3)
  const batch = await run(model, checkBatchMessages(three.map((p) => p.text), ''), checkBatchSchema(3), { numCtx: LIVE_CTX })
  allStats.push(batch.stats)
  r.batch3Sec = batch.wallMs / 1000
  const lists = splitBatchResult(parse<Parameters<typeof splitBatchResult>[0]>(batch.text) ?? {}, 3)
  three.forEach((p, i) => (r.batchFixed += score(p, applySuggestions(p.text, lists[i] as Suggestion[]))))
  r.batchTotal = three.reduce((a, p) => a + p.fixes.length, 0)
  raw.batch = lists
  console.log(`  batched 3: ${r.batch3Sec.toFixed(1)} s (vs ${r.check3Sec.toFixed(1)} s one by one), fixed ${r.batchFixed}/${r.batchTotal}`)

  const clean = await run(model, checkMessages(CLEAN, ctx), CHECK_SCHEMA)
  allStats.push(clean.stats)
  const cleanList = parse<{ suggestions: Suggestion[] }>(clean.text)?.suggestions ?? []
  r.falseAlarms = cleanList.filter((s) => s.type === 'grammar').length
  raw.check = checkOut
  raw.clean = cleanList
  console.log(`  check: ${r.check1Sec.toFixed(1)} s/paragraph, fixed ${r.checkFixed}/${r.checkTotal}, false alarms ${r.falseAlarms}`)

  // 3) Improve one sentence.
  const imp = await run(model, improveMessages(IMPROVE_TEXT, { summary: '', paragraph: '' }), IMPROVE_SCHEMA)
  allStats.push(imp.stats)
  r.improveSec = imp.wallMs / 1000
  raw.improve = parse(imp.text) ?? imp.text
  console.log(`  improve: ${r.improveSec.toFixed(1)} s`)

  // 4) Rewrite the whole 5-paragraph document.
  const rw = await run(model, rewriteMessages(PARAS.map((p) => p.text), ''), rewriteSchema(PARAS.length), { numCtx: 8192, maxTokens: 1024 })
  allStats.push(rw.stats)
  r.rewriteSec = rw.wallMs / 1000
  const paras = parse<{ paragraphs: { index: number; text: string }[] }>(rw.text)?.paragraphs ?? []
  r.rewriteParasOk = paras.length === PARAS.length
  for (const [i, p] of PARAS.entries()) {
    r.rewriteFixed += score(p, paras.find((x) => x.index === i)?.text ?? p.text)
    r.rewriteTotal += p.fixes.length
  }
  raw.rewrite = paras.length ? paras : rw.text
  console.log(`  rewrite: ${r.rewriteSec.toFixed(1)} s, fixed ${r.rewriteFixed}/${r.rewriteTotal}`)

  // Speeds averaged over all warm requests.
  const sum = (k: keyof ChatStats) => allStats.reduce((a, s) => a + (s[k] ?? 0), 0)
  r.promptTps = tps(sum('prompt_eval_count'), sum('prompt_eval_duration'))
  r.genTps = tps(sum('eval_count'), sum('eval_duration'))
  console.log(`  speed: reads ${r.promptTps.toFixed(0)} tok/s, writes ${r.genTps.toFixed(1)} tok/s`)

  writeFileSync(join(outDir, `${model.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(raw, null, 2), 'utf-8')
  await unloadModel(url, model)
  return r
}

function table(results: ModelResult[]): string {
  const head =
    '| Model | Load | On GPU | Writes tok/s | Check 1 para | Check 3 paras (one by one → batched) | Check fixes | False alarms | Improve | Rewrite 5 paras | Rewrite fixes | JSON ok |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|'
  const rows = results.map((r) =>
    r.error
      ? `| ${r.model} | error: ${r.error} |||||||||||`
      : `| ${r.model} | ${r.loadSec.toFixed(1)} s | ${r.gpuPct}% | ${r.genTps.toFixed(1)} | ${r.check1Sec.toFixed(1)} s | ` +
        `${r.check3Sec.toFixed(1)} s → ${r.batch3Sec.toFixed(1)} s (${r.batchFixed}/${r.batchTotal} fixed) | ` +
        `${r.checkFixed}/${r.checkTotal} | ${r.falseAlarms} | ${r.improveSec.toFixed(1)} s | ${r.rewriteSec.toFixed(1)} s | ` +
        `${r.rewriteFixed}/${r.rewriteTotal}${r.rewriteParasOk ? '' : ' ⚠ paragraphs'} | ${r.jsonOk}/${r.jsonTotal} |`
  )
  return [head, ...rows].join('\n')
}

async function main(): Promise<void> {
  const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS
  const outDir = join('bench-results', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
  mkdirSync(outDir, { recursive: true })
  const results: ModelResult[] = []
  for (const model of models) {
    try {
      results.push(await benchModel(model, outDir))
    } catch (err) {
      console.log(`  ✖ ${err instanceof Error ? err.message : err}`)
      results.push({ model, error: err instanceof Error ? err.message : String(err) } as ModelResult)
    }
  }
  const md = `# Assist Writer model benchmark\n\n${new Date().toLocaleString()}\n\n${table(results)}\n`
  writeFileSync(join(outDir, 'summary.md'), md, 'utf-8')
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2), 'utf-8')
  console.log('\n' + table(results))
  console.log(`\nSaved to ${outDir}`)
}

void main()
