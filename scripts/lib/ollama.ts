import type { ChatRequest, LoadedModel } from '../../src/shared/types'
export type { LoadedModel } from '../../src/shared/types'

/** Receives streamed text as it arrives. */
export type ChunkSink = (chunk: string) => void

/** Timing figures Ollama reports with each answer (durations in nanoseconds). */
export interface ChatStats {
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

export interface ChatResult {
  text: string
  stats: ChatStats
}


const inflight = new Map<string, AbortController>()

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export async function listModels(url: string): Promise<string[]> {
  const res = await fetch(`${trimUrl(url)}/api/tags`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`)
  const body = (await res.json()) as { models?: { name: string }[] }
  return (body.models ?? []).map((m) => m.name).sort()
}

/** Models currently loaded (Ollama's /api/ps). */
export async function loadedModels(url: string): Promise<LoadedModel[]> {
  const res = await fetch(`${trimUrl(url)}/api/ps`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`)
  const body = (await res.json()) as { models?: { name: string; size: number; size_vram: number }[] }
  return (body.models ?? []).map((m) => ({ name: m.name, size: m.size, sizeVram: m.size_vram }))
}

/** Unloads a model from memory right away. */
export async function unloadModel(url: string, model: string): Promise<void> {
  await fetch(`${trimUrl(url)}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 })
  })
}

/**
 * Loads a model into memory without generating anything, so the next request is fast.
 * `numCtx` must match later requests, or Ollama loads the model a second time.
 */
export async function warmUp(url: string, model: string, numCtx?: number, keepAlive: string | number = '30m'): Promise<void> {
  const res = await fetch(`${trimUrl(url)}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: keepAlive, ...(numCtx ? { options: { num_ctx: numCtx } } : {}) })
  })
  if (!res.ok) throw new Error(`Could not load ${model} (Ollama ${res.status})`)
}

export function cancelChat(requestId: string): void {
  inflight.get(requestId)?.abort()
  inflight.delete(requestId)
}

/**
 * Sends a chat request to Ollama and returns the full assistant text.
 * When `req.stream` is set, partial text is also passed to `onChunk` as it arrives.
 */
export async function chat(url: string, req: ChatRequest, onChunk: ChunkSink): Promise<string> {
  return (await chatDetailed(url, req, onChunk)).text
}

/** Like `chat`, but also returns Ollama's timing statistics. */
export async function chatDetailed(url: string, req: ChatRequest, onChunk: ChunkSink = () => {}): Promise<ChatResult> {
  const controller = new AbortController()
  inflight.set(req.requestId, controller)
  try {
    try {
      return await doChat(url, req, onChunk, controller.signal, true)
    } catch (err) {
      if (controller.signal.aborted) throw new Error('cancelled')
      // Models without a thinking mode reject the `think` flag; retry without it.
      if (err instanceof Error && /think/i.test(err.message)) {
        return await doChat(url, req, onChunk, controller.signal, false)
      }
      throw err
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error('cancelled')
    throw err
  } finally {
    inflight.delete(req.requestId)
  }
}

function pickStats(o: ChatStats): ChatStats {
  const { total_duration, load_duration, prompt_eval_count, prompt_eval_duration, eval_count, eval_duration } = o
  return { total_duration, load_duration, prompt_eval_count, prompt_eval_duration, eval_count, eval_duration }
}

async function doChat(
  url: string,
  req: ChatRequest,
  onChunk: ChunkSink,
  signal: AbortSignal,
  sendThink: boolean
): Promise<ChatResult> {
  const options: Record<string, unknown> = { temperature: req.temperature ?? 0.3 }
  if (req.numCtx) options.num_ctx = req.numCtx
  if (req.maxTokens) options.num_predict = req.maxTokens
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: !!req.stream,
    options,
    keep_alive: req.keepAlive ?? '30m'
  }
  if (req.schema) body.format = req.schema
  // Thinking makes the model far slower; writing help doesn't need it.
  if (sendThink) body.think = false

  let res: Response
  try {
    res = await fetch(`${trimUrl(url)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    if (signal.aborted) throw new Error('cancelled')
    throw new Error(`Cannot reach Ollama at ${url}. Is it running?`)
  }
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try {
      message = JSON.parse(text).error ?? text
    } catch {
      /* plain-text error */
    }
    throw new Error(`Ollama error (${res.status}): ${message}`)
  }

  if (!req.stream) {
    const json = (await res.json()) as { message?: { content?: string } } & ChatStats
    return { text: json.message?.content ?? '', stats: pickStats(json) }
  }

  // Streaming: newline-delimited JSON objects; the last one carries the statistics.
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let stats: ChatStats = {}
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const part = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean } & ChatStats
      if (part.error) throw new Error(`Ollama error: ${part.error}`)
      const chunk = part.message?.content ?? ''
      if (chunk) {
        full += chunk
        onChunk(chunk)
      }
      if (part.done) stats = pickStats(part)
    }
  }
  return { text: full, stats }
}
