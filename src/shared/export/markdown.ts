import type { DocNode } from '../types'
import { runStyle } from './common'

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1')
}

function inline(nodes: DocNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n'
      if (n.type === 'image') {
        // Embedded as a data URL so the Markdown file is self-contained (wrapping can't be expressed).
        const src = String(n.attrs?.src ?? '')
        const alt = String(n.attrs?.alt || 'image').replace(/[[\]]/g, '')
        return src.startsWith('data:image/') ? `![${alt}](${src})` : ''
      }
      if (n.type !== 'text') return inline(n.content)
      const s = runStyle(n)
      const raw = n.text ?? ''
      if (s.code) return '`' + raw.replace(/`/g, '\\`') + '`'
      // Keep surrounding spaces outside the markers, or Markdown won't recognise them.
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!
      let core = escapeMd(m[2])
      if (!core) return raw
      if (s.strike) core = `~~${core}~~`
      if (s.italic) core = `*${core}*`
      if (s.bold) core = `**${core}**`
      if (s.underline) core = `<u>${core}</u>`
      return m[1] + core + m[3]
    })
    .join('')
}

function block(node: DocNode, indent: string): string[] {
  switch (node.type) {
    case 'paragraph': {
      const text = inline(node.content)
      return [indent + escapeLineStart(text).replace(/\n/g, '\n' + indent)]
    }
    case 'heading':
      return [indent + '#'.repeat(node.attrs?.level ?? 1) + ' ' + inline(node.content)]
    case 'codeBlock': {
      const lang = node.attrs?.language ?? ''
      const code = (node.content ?? []).map((c) => c.text ?? '').join('')
      return [indent + '```' + lang, ...code.split('\n').map((l) => indent + l), indent + '```']
    }
    case 'horizontalRule':
      return [indent + '---']
    case 'blockquote':
      return blocks(node.content, indent).map((l) => (l === '' ? indent + '>' : indent + '> ' + l.slice(indent.length)))
    case 'bulletList':
    case 'orderedList': {
      const out: string[] = []
      let n = node.attrs?.start ?? 1
      for (const item of node.content ?? []) {
        const marker = node.type === 'bulletList' ? '- ' : `${n++}. `
        const inner = blocks(item.content, indent + ' '.repeat(marker.length)).filter((l) => l.trim() !== '')
        if (inner.length === 0) inner.push(indent + ' '.repeat(marker.length))
        inner[0] = indent + marker + inner[0].slice(indent.length + marker.length)
        out.push(...inner)
      }
      return out
    }
    default:
      return blocks(node.content, indent)
  }
}

function blocks(nodes: DocNode[] = [], indent: string): string[] {
  const out: string[] = []
  nodes.forEach((n, i) => {
    if (i > 0) out.push('')
    out.push(...block(n, indent))
  })
  return out
}

/** Escapes characters that would otherwise start a Markdown block (heading, list, quote). */
function escapeLineStart(line: string): string {
  return line.replace(/^(\d+)\. /, '$1\\. ').replace(/^(#|>|[-+] )/, '\\$1')
}

export function docToMarkdown(doc: DocNode): string {
  return blocks(doc.content, '').join('\n').replace(/\s+$/, '') + '\n'
}
