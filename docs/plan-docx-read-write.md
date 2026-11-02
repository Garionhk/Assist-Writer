# Plan: better DOCX read/write (our own code)

Status: **done** (2026-10-14). Reader: `src/shared/import/docx.ts` (+ `xml.ts`), tests: `src/shared/import/docx.test.ts`. No WordCraft code, no new PDF engine:
PDF export stays as it is (headless Edge).

## Today

- **Write** (`src/shared/export/docx.ts`, `docx` npm library): headings, lists, alignment, fonts
  (Latin + east-Asian pairing), sizes, images inline and floating with all 7 wrap modes, side and
  margin. Small gaps only.
- **Read** (`mammoth` in `src/renderer/src/fileFormats.ts`): converts to simple HTML and loses
  image wrap/position/size/margin (every image comes in inline), fonts and sizes, sometimes
  underline/strike/alignment and bullet-vs-number. A file saved by Assist Writer does not reopen the same.

## Plan

1. **Own DOCX reader** (TypeScript, e.g. `src/shared/import/docx.ts`), replacing `mammoth`: unzip
   with JSZip (make it a direct dependency), parse `word/document.xml`, `styles.xml`,
   `numbering.xml`, `_rels/document.xml.rels` and `media/*` with DOMParser, and build the editor's
   JSON directly:
   - headings 1–3 (paragraph styles), alignment, line breaks, tabs;
   - bold, italic, underline, strike, fonts (`w:rFonts` ascii/eastAsia), sizes (`w:sz`), incl. style inheritance;
   - lists from `numbering.xml` (bullet vs numbered, nesting);
   - pictures: `wp:inline` → inline; `wp:anchor` → square/tight/through/topBottom/behind/front from the wrap element and `behindDoc`, side from `wp:positionH` align, margin from `distT/B/L/R`, x/y from offsets, size from `wp:extent`;
   - tracked changes accepted; tables, text boxes, footnotes → their text as paragraphs;
   - bounded and lenient: caps on sizes/counts, never throws on odd files.
2. **Writer check**: everything the reader understands is written the same way, so save → reopen is identical.
3. Remove `mammoth`. Runs in the page for both the desktop and web versions; no Rust changes.

## Tests

- Round trip: editor JSON → DOCX → editor JSON is identical (formatting, lists, Traditional
  Chinese, images in every wrap mode with side/margin/x/y).
- Word files from other programs (fixtures) open with sensible results.
- Real app: `test_with_image.awd` (a copy) → save as Word → reopen → compare.

Effort: about one session.
