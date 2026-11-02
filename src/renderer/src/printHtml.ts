import { alignImage } from './editor/image'

/** Wraps editor HTML in a standalone page styled for printing to PDF. */
export function printHtml(bodyHtml: string, title: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 20mm; }
  body { font-family: Calibri, "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 12pt; line-height: 1.5; color: #111; margin: 0; }
  p { margin: 0 0 0.5em; }
  h1 { font-size: 24pt; margin: 0.6em 0 0.3em; }
  h2 { font-size: 20pt; margin: 0.6em 0 0.3em; }
  h3 { font-size: 16pt; margin: 0.6em 0 0.3em; }
  blockquote { margin: 0 0 0.5em 1.5em; padding-left: 0.8em; border-left: 3px solid #ccc; color: #444; }
  pre { font-family: Consolas, monospace; background: #f4f4f4; padding: 0.6em; white-space: pre-wrap; }
  code { font-family: Consolas, monospace; }
  hr { border: none; border-top: 1px solid #999; }
  ul, ol { margin: 0 0 0.5em; padding-left: 1.6em; }
  h1, h2, h3 { page-break-after: avoid; }
  p { orphans: 2; widows: 2; }
  .ai-change { background: none; }
  /* Images: paragraphs anchor behind/in-front images; floats are cleared at the end. */
  body { position: relative; isolation: isolate; }
  p, h1, h2, h3, li { position: relative; }
  body::after { content: ''; display: block; clear: both; }
</style></head>
<body>${bodyHtml}
<script>
  // Images line up with their text and wrap around their outlines, as in the editor.
  (function () {
    var align = ${alignImage.toString()};
    document.querySelectorAll('img[data-wrap]').forEach(function (el) { align(el) });
  })();
</script>
</body></html>`
}
