import type { ReactNode } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { cleanFontFamily } from '../../../shared/export/common'
import type { WritingStyle } from '../../../shared/styles'
import { t, type Lang } from '../i18n'

export const FONTS: { value: string; label: string }[] = [
  { value: 'Calibri', label: 'Calibri' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Segoe UI', label: 'Segoe UI' },
  { value: 'Consolas', label: 'Consolas' },
  { value: 'Microsoft YaHei', label: '微軟雅黑 Microsoft YaHei' },
  { value: 'DengXian', label: '等線 DengXian' },
  { value: 'SimSun', label: '宋體 SimSun' },
  { value: 'SimHei', label: '黑體 SimHei' },
  { value: 'KaiTi', label: '楷體 KaiTi' },
  { value: 'FangSong', label: '仿宋 FangSong' },
  { value: 'Microsoft JhengHei', label: '微軟正黑體 Microsoft JhengHei' }
]

export const SIZES = ['8', '9', '10', '10.5', '11', '12', '14', '16', '18', '20', '22', '24', '28', '32', '36', '48', '72']

interface Props {
  editor: Editor
  liveCheck: boolean
  historyOpen: boolean
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onExport: (format: 'pdf' | 'docx' | 'rtf' | 'md' | 'txt') => void
  onImprove: () => void
  onRewrite: () => void
  onToggleLive: () => void
  onToggleHistory: () => void
  /** View zoom control (current level, − and +). */
  zoom?: ReactNode
  onSettings: () => void
  onInsertImage: (file: File) => void
  /** Desktop: pick the file with the system dialog instead (so its path is known, for linking). */
  onPickImage?: () => void
  styles: WritingStyle[]
  activeStyleId: string | null
  onStyleChange: (id: string | null) => void
  onManageStyles: () => void
  language: Lang
  onToggleLanguage: () => void
}

export function Toolbar(p: Props) {
  const { editor } = p
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const style = e.getAttributes('textStyle')
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        font: cleanFontFamily(style.fontFamily) ?? '',
        size: (style.fontSize as string | undefined)?.replace(/pt$/, '') ?? '',
        block: e.isActive('heading', { level: 1 })
          ? 'h1'
          : e.isActive('heading', { level: 2 })
            ? 'h2'
            : e.isActive('heading', { level: 3 })
              ? 'h3'
              : 'p',
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        quote: e.isActive('blockquote'),
        align: (['center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
        canUndo: e.can().undo(),
        canRedo: e.can().redo()
      }
    }
  })

  const chain = () => editor.chain().focus()

  const setBlock = (v: string) => {
    if (v === 'p') chain().setParagraph().run()
    else chain().setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run()
  }

  return (
    <div className="toolbar" role="toolbar">
      <div className="group">
        <button title={t('New (Ctrl+N)')} onClick={p.onNew}>{t('New')}</button>
        <button title={t('Open (Ctrl+O)')} onClick={p.onOpen}>{t('Open')}</button>
        <button title={t('Save (Ctrl+S)')} onClick={p.onSave}>{t('Save')}</button>
        <select
          className="export"
          title={t('Export')}
          value=""
          onChange={(e) => {
            if (e.target.value) p.onExport(e.target.value as Parameters<Props['onExport']>[0])
          }}
        >
          <option value="">{t('Export…')}</option>
          <option value="pdf">PDF (.pdf)</option>
          <option value="docx">Word (.docx)</option>
          <option value="rtf">{t('Rich Text (.rtf)')}</option>
          <option value="md">Markdown (.md)</option>
          <option value="txt">{t('Plain Text (.txt)')}</option>
        </select>
      </div>

      <div className="group">
        <button title={t('Undo (Ctrl+Z)')} disabled={!s.canUndo} onClick={() => chain().undo().run()}>↶</button>
        <button title={t('Redo (Ctrl+Y)')} disabled={!s.canRedo} onClick={() => chain().redo().run()}>↷</button>
      </div>

      <div className="group">
        <select title={t('Paragraph style')} value={s.block} onChange={(e) => setBlock(e.target.value)}>
          <option value="p">{t('Normal')}</option>
          <option value="h1">{t('Heading 1')}</option>
          <option value="h2">{t('Heading 2')}</option>
          <option value="h3">{t('Heading 3')}</option>
        </select>
        <select
          className="font"
          title={t('Font')}
          value={s.font}
          onChange={(e) =>
            e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run()
          }
        >
          <option value="">{t('Default font')}</option>
          {FONTS.map((f) => (
            <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
              {f.label}
            </option>
          ))}
          {s.font && !FONTS.some((f) => f.value === s.font) && <option value={s.font}>{s.font}</option>}
        </select>
        <select
          className="size"
          title={t('Font size (pt)')}
          value={s.size}
          onChange={(e) => (e.target.value ? chain().setFontSize(`${e.target.value}pt`).run() : chain().unsetFontSize().run())}
        >
          <option value="">{t('Size')}</option>
          {SIZES.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
          {s.size && !SIZES.includes(s.size) && <option value={s.size}>{s.size}</option>}
        </select>
      </div>

      <div className="group">
        <button title={t('Bold (Ctrl+B)')} className={s.bold ? 'on' : ''} onClick={() => chain().toggleBold().run()}>
          <b>B</b>
        </button>
        <button title={t('Italic (Ctrl+I)')} className={s.italic ? 'on' : ''} onClick={() => chain().toggleItalic().run()}>
          <i>I</i>
        </button>
        <button title={t('Underline (Ctrl+U)')} className={s.underline ? 'on' : ''} onClick={() => chain().toggleUnderline().run()}>
          <u>U</u>
        </button>
        <button title={t('Strikethrough')} className={s.strike ? 'on' : ''} onClick={() => chain().toggleStrike().run()}>
          <s>S</s>
        </button>
      </div>

      <div className="group">
        <button title={t('Bullet list')} className={s.bullet ? 'on' : ''} onClick={() => chain().toggleBulletList().run()}>
          • {t('List')}
        </button>
        <button title={t('Numbered list')} className={s.ordered ? 'on' : ''} onClick={() => chain().toggleOrderedList().run()}>
          1. {t('List')}
        </button>
        <button title={t('Quote')} className={s.quote ? 'on' : ''} onClick={() => chain().toggleBlockquote().run()}>
          ❝
        </button>
        <label
          className="toolbar-file"
          title={t('Insert a JPG or PNG image (you can also paste or drag one in)')}
          onClick={(e) => {
            if (!p.onPickImage) return
            e.preventDefault()
            p.onPickImage()
          }}
        >
          🖼 {t('Image')}
          <input
            type="file"
            accept=".jpg,.jpeg,.png,image/jpeg,image/png"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) p.onInsertImage(file)
            }}
          />
        </label>
        <select title={t('Alignment')} value={s.align} onChange={(e) => chain().setTextAlign(e.target.value).run()}>
          <option value="left">{t('Left')}</option>
          <option value="center">{t('Center')}</option>
          <option value="right">{t('Right')}</option>
          <option value="justify">{t('Justify')}</option>
        </select>
      </div>

      <div className="group ai">
        <select
          className="style"
          title={t('Writing style the AI aims for')}
          value={p.activeStyleId ?? ''}
          onChange={(e) => {
            if (e.target.value === '__manage') p.onManageStyles()
            else p.onStyleChange(e.target.value || null)
          }}
        >
          <option value="">{t('Style: none (general)')}</option>
          {p.styles.map((st) => (
            <option key={st.id} value={st.id}>
              {t('Style: {name}', { name: st.name })}
            </option>
          ))}
          <option value="__manage">{t('Manage styles…')}</option>
        </select>
        <button title={t('Improve the selected text, or the current paragraph (Ctrl+Shift+I)')} onClick={p.onImprove}>
          ✨ {t('Improve')}
        </button>
        <button title={t('Rewrite the whole document with the large model')} onClick={p.onRewrite}>
          📝 {t('Rewrite doc')}
        </button>
        <button
          title={t('Check grammar and style automatically while you type')}
          className={p.liveCheck ? 'on' : ''}
          onClick={p.onToggleLive}
        >
          {p.liveCheck ? t('Live check: On') : t('Live check: Off')}
        </button>
      </div>

      <div className="group right">
        {p.zoom}
        <button title={t('Change history (Ctrl+H)')} className={p.historyOpen ? 'on' : ''} onClick={p.onToggleHistory}>
          {t('History')}
        </button>
        <button
          className="lang-toggle"
          title={p.language === 'en' ? '切換為繁體中文介面' : 'Switch the interface to English'}
          onClick={p.onToggleLanguage}
        >
          {p.language === 'en' ? '中文' : 'EN'}
        </button>
        <button title={t('Settings (Ctrl+,)')} onClick={p.onSettings}>
          ⚙
        </button>
      </div>
    </div>
  )
}
