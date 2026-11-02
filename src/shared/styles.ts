// Built-in writing styles. Users can edit these, delete them, or add their own in Settings.

export interface WritingStyle {
  id: string
  name: string
  /** Instructions given to the model describing the target style. */
  prompt: string
  /** True for styles that ship with the app (they can be restored to default). */
  builtin?: boolean
}

export function findStyle(styles: WritingStyle[], id: string | null): WritingStyle | null {
  return (id && styles.find((s) => s.id === id)) || null
}

export const DEFAULT_STYLES: WritingStyle[] = [
  {
    id: 'grade-3-5',
    name: 'Elementary (Grade 3–5)',
    builtin: true,
    prompt:
      'Write like a strong student in grades 3-5 (age 8-11). Use short, simple sentences (mostly 8-12 words) and everyday words a child knows. ' +
      'One idea per sentence. Use simple connectors like "and", "but", "because", "then". Be concrete and friendly; avoid abstract words, idioms and jargon. ' +
      'For Chinese text, write at the level of 小學三至五年級: 常用字詞、短句、簡單的關聯詞，生動但不複雜。'
  },
  {
    id: 'grade-6-8',
    name: 'Middle School (Grade 6–8)',
    builtin: true,
    prompt:
      'Write like a capable student in grades 6-8 (age 11-14). Use clear sentences of varied length, including some compound and complex sentences. ' +
      'Use a growing but common vocabulary, simple transitions ("however", "for example", "as a result"), and a clear topic sentence for each paragraph. ' +
      'Add some descriptive detail, but keep the language natural and not overly formal. ' +
      'For Chinese text, write at the level of 小學六年級至初中二年級: 語句通順，適當使用修辭和成語，但不堆砌。'
  },
  {
    id: 'grade-9-10',
    name: 'High School (Grade 9–10)',
    builtin: true,
    prompt:
      'Write like a good high-school student in grades 9-10. Use well-organized paragraphs with a clear main idea and supporting evidence. ' +
      'Vary sentence structure, use precise vocabulary and smooth transitions between ideas. Keep a semi-formal tone; avoid slang and avoid sounding pretentious. ' +
      'For Chinese text, write at the level of 高一至高二: 結構清晰，用詞準確，適當運用修辭，有一定的思想深度。'
  },
  {
    id: 'grade-11-12',
    name: 'High School (Grade 11–12)',
    builtin: true,
    prompt:
      'Write like an advanced high-school student in grades 11-12 preparing for university. Use a mature, formal academic tone, sophisticated but accurate vocabulary, ' +
      'and varied, well-controlled sentence structures. Build clear arguments with logical flow, nuance and evidence; use cohesive devices between paragraphs. ' +
      'For Chinese text, write at the level of 高三/高考優秀作文: 論證嚴密，語言凝練有文采，引用和修辭恰當。'
  },
  {
    id: 'university-english',
    name: 'University (English degree)',
    builtin: true,
    prompt:
      'Write like a university student majoring in English literature and writing. Use elegant, precise and expressive prose with a rich vocabulary, ' +
      'careful rhythm, varied syntax and deliberate stylistic choices (parallelism, well-placed imagery, strong verbs). Stay clear and controlled; avoid purple prose and clichés. ' +
      'For Chinese text, write like a 中文系大學生: 文筆優美，用詞考究，句式富於變化，富有文學性但不浮誇。'
  },
  {
    id: 'lawyer',
    name: 'Professional lawyer',
    builtin: true,
    prompt:
      'Write like an experienced lawyer. Be precise, formal and unambiguous. Define terms consistently and use them the same way every time; avoid vague words and emotional language. ' +
      'Prefer clear plain-legal English over archaic legalese, but keep necessary legal terms of art. Structure reasoning logically (issue, rule, analysis, conclusion where relevant) ' +
      'and qualify statements carefully. ' +
      'For Chinese text, use 規範的法律文書語言: 嚴謹、準確、無歧義，術語統一，邏輯清晰。'
  },
  {
    id: 'scientist',
    name: 'Professional scientist',
    builtin: true,
    prompt:
      'Write like a professional scientist writing for a peer-reviewed journal. Be objective, precise and concise. Use correct technical terminology, ' +
      'state claims with appropriate hedging ("suggests", "is consistent with"), separate observations from interpretation, and quantify where possible. ' +
      'Prefer clear, direct sentences; avoid rhetorical flourishes and unsupported claims. ' +
      'For Chinese text, use 規範的科技論文語言: 客觀、準確、簡潔，術語規範，表述嚴謹。'
  },
  {
    id: 'scholar',
    name: 'Scholar expert in the topic',
    builtin: true,
    prompt:
      "Write like a leading scholar who is an expert in this document's subject. First infer the topic and field from the document, then use that field's " +
      'conventions, terminology and standards of argument. Show depth: precise concepts, nuanced distinctions, awareness of context and counter-arguments. ' +
      'Keep an authoritative but readable academic tone. ' +
      'For Chinese text, write like 該領域的資深學者: 專業術語準確，論述有深度，符合該學科的學術規範。'
  },
  {
    id: 'business',
    name: 'Business professional',
    builtin: true,
    prompt:
      'Write like an experienced business professional. Be clear, concise and action-oriented: lead with the main point, use short paragraphs, ' +
      'active voice and concrete specifics (numbers, dates, owners, next steps). Keep a polite, confident, professional tone; avoid jargon, filler and hype. ' +
      'For Chinese text, use 規範的商務語言: 簡潔明瞭，重點突出，禮貌專業。'
  },
  {
    id: 'novelist',
    name: 'Creative writer / novelist',
    builtin: true,
    prompt:
      'Write like a skilled novelist. Make the prose vivid and immersive: show rather than tell, use sensory detail, strong specific verbs, ' +
      'fresh imagery and varied sentence rhythm. Keep the voice and point of view consistent, and keep dialogue natural. Avoid clichés and overwriting. ' +
      'For Chinese text, write like 優秀的小說家: 描寫生動細膩，語言有畫面感和節奏感，避免陳詞濫調。'
  }
]
