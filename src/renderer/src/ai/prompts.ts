import type { ChatMessage, WritingStyle } from '../../../shared/types'

/** Live checking: suggestions always stay in the text's own language. */
const LANGUAGE_RULE =
  'The text may be English, Chinese, or a mix. Always keep the original language: correct English as English and Chinese as Chinese. ' +
  'Never translate, even if the target writing style is about another language. ' +
  'Write every "reason" in the same language as the text it is about, in one short sentence.'

/** Improve and Rewrite: keep the language, unless the chosen style asks for another one (e.g. translation). */
const REWRITE_LANGUAGE_RULE =
  'The text may be English, Chinese, or a mix. Keep each part in its original language, ' +
  'UNLESS the TARGET WRITING STYLE says to write in a different language (for example a translation style): then write in that language. ' +
  'Write the "reason" in the language of your output, in one short sentence.'

/**
 * Formatting tags (see toTagged in editor/changes.ts): the model must carry them over to the
 * matching words, so bold/italic/fonts survive translation and free rewording.
 */
export function hasFormatTags(text: string): boolean {
  return /<\/?f\d+>/.test(text)
}

export function hasImagePlaceholders(text: string): boolean {
  return /<img\d+\/>/.test(text)
}

const IMAGE_RULE =
  '\nIMAGES: placeholders like <img1/> stand for pictures in the document. Keep every placeholder exactly once, ' +
  'at the matching place in your output (between the same words, or where those words went). Never remove, repeat, or renumber them.'

/** The extra rules a text needs: formatting tags and/or image placeholders. */
function tagRules(texts: string[]): string {
  return (texts.some(hasFormatTags) ? FORMAT_TAG_RULE : '') + (texts.some(hasImagePlaceholders) ? IMAGE_RULE : '')
}

const FORMAT_TAG_RULE =
  '\nFORMATTING TAGS: some words are wrapped in tags like <f1>…</f1>, <f2>…</f2>. They mark formatting (bold, italic, a font…). ' +
  'In your output, wrap exactly the words that carry the same meaning as each tagged phrase — the same words, their translation, or their rewording — in the same tag. ' +
  'Keep each tagged span about as short as in the input: tag the matching phrase only, not the words around it. ' +
  'Keep every tag pair, use only the tag numbers given, never nest or cross tags differently from the input, and put no tags anywhere else.\n' +
  'Example — input: "I <f1>miss you</f1> when I see the <f2>empty chair</f2>." ' +
  'Good output: "Your <f1>absence aches</f1> in me whenever I glimpse the <f2>vacant chair</f2>." ' +
  'Bad output: "<f1>Your absence aches in me</f1> whenever I glimpse <f2>the vacant chair by the window</f2>." (spans too wide)'

/** Describes the chosen writing style for the system prompt (empty when none is selected). */
export function styleBlock(style: WritingStyle | null | undefined): string {
  if (!style || !style.prompt.trim()) return ''
  return (
    `\n\nTARGET WRITING STYLE: ${style.name}\n${style.prompt.trim()}\n` +
    'Make the writing match this style (vocabulary, sentence length and structure, tone, and language if the style names one). ' +
    'The style never changes the meaning or facts.'
  )
}

/**
 * Context window used for every request to the live model. Keeping it identical matters:
 * Ollama reloads a model whenever a request asks for a different context size.
 */
export const LIVE_CTX = 8192

const SUGGESTION_ITEM = {
  type: 'object',
  properties: {
    original: { type: 'string' },
    suggestion: { type: 'string' },
    reason: { type: 'string' },
    type: { type: 'string', enum: ['grammar', 'style'] }
  },
  required: ['original', 'suggestion', 'reason', 'type']
}

export const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: { type: 'array', items: SUGGESTION_ITEM }
  },
  required: ['suggestions']
}

/** Output format for checking several paragraphs in one request: one entry per paragraph. */
export function checkBatchSchema(paragraphCount: number) {
  return {
    type: 'object',
    properties: {
      paragraphs: {
        type: 'array',
        minItems: paragraphCount,
        maxItems: paragraphCount,
        items: {
          type: 'object',
          properties: { index: { type: 'integer' }, suggestions: { type: 'array', items: SUGGESTION_ITEM } },
          required: ['index', 'suggestions']
        }
      }
    },
    required: ['paragraphs']
  }
}

function checkRules(style: WritingStyle | null | undefined, unit: 'the paragraph' | 'its paragraph'): string {
  const styleRule = style
    ? '- type "style": rewording that brings the sentence closer to the TARGET WRITING STYLE below, or makes it clearly better (clearer, more natural, richer). Only when the gain is real.\n'
    : '- type "style": rewording that makes a sentence clearly better: clearer, more natural, more vivid or richer. Only when the gain is real.\n'
  return (
    LANGUAGE_RULE +
    '\nRules:\n' +
    '- type "grammar": spelling, grammar, punctuation, wrong word, wrong measure word or particle (Chinese 的/地/得 etc.).\n' +
    styleRule +
    `- "original" MUST be copied exactly, character for character, from ${unit}. Keep it as short as possible: a word, phrase or one sentence.\n` +
    '- "suggestion" replaces "original" exactly and must fit the surrounding text.\n' +
    '- "reason" names the specific problem, not just a category. Good: "Subject-verb agreement: he goes, not he go." / "修飾動詞應該用「地」。" Bad: "grammar".\n' +
    '- Do not change the meaning. Do not comment on content. Do not suggest trivial or purely personal-taste edits.\n' +
    `- At most 5 suggestions per paragraph. If ${unit} is fine, its list is empty.\n` +
    'Respond only with JSON matching the schema.' +
    styleBlock(style)
  )
}

/** Checks several paragraphs in one request (faster than one request each). */
export function checkBatchMessages(paragraphs: string[], summary: string, style?: WritingStyle | null): ChatMessage[] {
  const system =
    'You are a careful writing assistant. You review several numbered paragraphs and propose small, precise edits for each one separately.\n' +
    'Return one entry per paragraph, with the same index, in order.\n' +
    checkRules(style, 'its paragraph')
  let user = ''
  if (summary) user += `Document overview (for context only):\n${summary}\n\n`
  user += 'Paragraphs to review:\n' + paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

export function checkMessages(
  paragraph: string,
  context: { summary: string; before: string; after: string },
  style?: WritingStyle | null
): ChatMessage[] {
  const system =
    'You are a careful writing assistant. You review ONE paragraph at a time and propose small, precise edits.\n' +
    checkRules(style, 'the paragraph')

  let user = ''
  if (context.summary) user += `Document overview (for context only):\n${context.summary}\n\n`
  if (context.before) user += `Previous paragraph (context only, do not edit):\n${context.before}\n\n`
  if (context.after) user += `Next paragraph (context only, do not edit):\n${context.after}\n\n`
  user += `Paragraph to review:\n<<<\n${paragraph}\n>>>`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

export function summaryMessages(docText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'Summarise the document below in 2-4 sentences: its topic, purpose, audience and tone. ' +
        'Write the summary in the same language as the document. Output only the summary.'
    },
    { role: 'user', content: docText }
  ]
}

export const IMPROVE_SCHEMA = {
  type: 'object',
  properties: { rewrite: { type: 'string' }, reason: { type: 'string' } },
  required: ['rewrite', 'reason']
}

export function improveMessages(
  text: string,
  context: { summary: string; paragraph: string },
  style?: WritingStyle | null
): ChatMessage[] {
  const goal = style
    ? 'Rewrite the selected text so it is grammatically correct and written in the TARGET WRITING STYLE below. ' +
      'Keep the meaning, facts and point of view; the length may change as the style requires. '
    : 'Rewrite the selected text so it is grammatically correct, clearer, and richer: ' +
      'better word choice, smoother rhythm, more vivid and precise expression. Keep the meaning, facts, point of view and roughly the same length (it may be up to 50% longer). '
  const system =
    'You are a skilled editor. ' +
    goal +
    REWRITE_LANGUAGE_RULE +
    ' If the selection is a fragment, the rewrite must still fit into the surrounding paragraph. ' +
    'Respond only with JSON: "rewrite" is the replacement text, "reason" briefly says what was improved.' +
    tagRules([text]) +
    styleBlock(style)
  let user = ''
  if (context.summary) user += `Document overview (context only):\n${context.summary}\n\n`
  if (context.paragraph && context.paragraph !== text) user += `Surrounding paragraph (context only):\n${context.paragraph}\n\n`
  user += `Selected text to rewrite:\n<<<\n${text}\n>>>`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/** Output format for a rewrite; fixing the array length stops models from dropping paragraphs. */
export function rewriteSchema(paragraphCount: number) {
  return {
    type: 'object',
    properties: {
      paragraphs: {
        type: 'array',
        minItems: paragraphCount,
        maxItems: paragraphCount,
        items: {
          type: 'object',
          properties: { index: { type: 'integer' }, text: { type: 'string' } },
          required: ['index', 'text']
        }
      }
    },
    required: ['paragraphs']
  }
}

export function rewriteMessages(paragraphs: string[], instruction: string, style?: WritingStyle | null): ChatMessage[] {
  const goal = style
    ? 'Fix all grammar, spelling and punctuation, and rewrite every paragraph in the TARGET WRITING STYLE described at the end, ' +
      "while keeping the author's meaning, facts and structure. "
    : 'Fix all grammar, spelling and punctuation, and rewrite sentences to be clearer, more fluent and richer, ' +
      "while keeping the author's meaning, facts, structure and voice. "
  const system =
    'You are an expert editor improving a whole document. ' +
    goal +
    REWRITE_LANGUAGE_RULE +
    '\nThe document is given as numbered paragraphs. Return every paragraph with the SAME index, one output item per input paragraph, in order. ' +
    'Never merge, split, add or drop paragraphs. Headings stay short headings. If a paragraph needs no change, return it unchanged. ' +
    'Each "text" must contain ONLY the rewritten paragraph itself: no explanations, no "Reason:", no notes, no quotes around it.' +
    (instruction.trim() ? `\nAdditional instruction from the author: ${instruction.trim()}` : '') +
    '\nRespond only with JSON matching the schema.' +
    tagRules(paragraphs) +
    styleBlock(style)
  const user = paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/** Parses model JSON output, tolerating code fences or stray text around the object. */
export function parseJson<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
    throw new Error('The model returned an unreadable answer.')
  }
}
