import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * Invisible mark placed on text inserted by an accepted AI change. It carries the history
 * entry id, and ProseMirror keeps it attached to the text as the document is edited, so a
 * single change can be found and undone later.
 */
export const AiChange = Mark.create({
  name: 'aiChange',
  inclusive: false,

  addAttributes() {
    return {
      changeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-ai-change'),
        renderHTML: (attrs) => ({ 'data-ai-change': attrs.changeId })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-ai-change]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'ai-change' }, HTMLAttributes), 0]
  }
})
