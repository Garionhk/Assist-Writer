# Assist Writer

**A private AI writing assistant for English and Traditional Chinese that runs entirely on your own PC.**

Assist Writer is a desktop word processor with a built-in writing coach. As you type, it checks grammar and style and suggests better wording. You confirm every change before it replaces your text, and you can undo any single change later. The AI runs locally through [Ollama](https://ollama.com), so your writing never leaves your computer: no account, no cloud, no subscription.

- **Live checking** with underlines: red for grammar, blue for style. Click to see the suggestion and the reason, then **Accept**, **Reject** or **Ignore always**.
- **Improve** a sentence or paragraph, or **Rewrite** a whole document, in the writing style you choose (school levels, lawyer, scientist, business, novelist, your own…).
- **Formatting survives AI changes**, even translations: bold, italic, fonts and sizes stay on the matching words.
- **Change history** with selective undo of any one AI change.
- A real editor: fonts, headings, lists, images with Word-style text wrapping, zoom, PDF / Word / RTF / Markdown export, and Word import.
- Interface in **English or 繁體中文**, switchable with one click.
- **Desktop app** for Windows, plus a **web version** you can use from your phone or laptop on the same network.

Built with Rust ([Tauri](https://tauri.app)), React and [TipTap](https://tiptap.dev). The installer is about 2 MB.

## Download

**Latest version: [0.2.0](https://github.com/Garionhk/Assist-Writer/releases/tag/v0.2.0)** (all versions: [Releases](https://github.com/Garionhk/Assist-Writer/releases))

| Download | Size | What it is |
|---|---|---|
| [**AssistWriter-Setup-0.2.0.exe**](https://github.com/Garionhk/Assist-Writer/releases/download/v0.2.0/AssistWriter-Setup-0.2.0.exe) | 2.1 MB | **Installer (recommended).** Start menu and desktop shortcuts, opens `.awd` files, uninstall from Windows Settings. |
| [AssistWriter-Portable-0.2.0.exe](https://github.com/Garionhk/Assist-Writer/releases/download/v0.2.0/AssistWriter-Portable-0.2.0.exe) | 5.0 MB | The app as a single file; runs without installing. |
| [AssistWriter-Web-0.2.0.zip](https://github.com/Garionhk/Assist-Writer/releases/download/v0.2.0/AssistWriter-Web-0.2.0.zip) | 1.5 MB | Web version: unzip and run `Start Assist Writer Web.bat`. |

The files aren't code-signed, so Windows SmartScreen may warn the first time: click **More info → Run anyway**.

### Getting started

1. **Install:** run the installer. Before installing, it shows how much graphics card memory the AI needs.
2. **Set up the AI:** when Assist Writer first opens and Ollama or the AI models are missing, its **Setup** window opens. It shows your graphics card and its memory, installs Ollama, and downloads the models with progress bars. You don't need to install anything by hand. It's also under **AI → Set Up Ollama and Models…**.
3. **Write:** start typing. When you pause, Assist Writer checks the paragraph and underlines what it would change.

### What you'll see

- **Toolbar** at the top:
  - File buttons, undo / redo, paragraph style, font and size, bold / italic / underline / strikethrough, lists, quote, **🖼 Image** and alignment.
  - The writing **Style** picker, **✨ Improve**, **📝 Rewrite doc** and **Live check: On/Off**.
  - On the right: zoom (− 100% +), **History**, the **中文 / EN** language button and **⚙ Settings**.
- **The page** in the middle, like a word processor. **Red** wavy underlines mark grammar problems and **blue** ones mark style improvements. Click one to see the original, the suggestion and the reason, with **Accept**, **Reject** and **Ignore always**.
- **Status bar** at the bottom: the document name (● when unsaved), the Ollama model in use, live checking progress, the active writing style, and the word count.
- **History panel** (`Ctrl+H`) on the right: every accepted AI change, before → after, with **Undo this change**.

## Requirements

- **Windows 10 or 11** (64-bit). The app uses Windows' built-in WebView2; the installer fetches it if it's missing.
- **Graphics card memory (VRAM)** for the AI models:

  | Task | Default model | Download | Needs about |
  |---|---|---|---|
  | Checking while you type, Improve | `qwen3.5:9b` | 6.6 GB | 8 GB VRAM |
  | Rewriting whole documents | `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL` | 14.1 GB | 16 GB VRAM |

  The two models are used one at a time, so **16 GB runs everything at full speed** and **8 GB is the minimum** for fast checking while you type. With less memory, or without a graphics card, everything still works, but more slowly. You can pick smaller or different models in **Settings**; any model installed in Ollama can be used.
- **Disk space:** about 24 GB in all (Ollama about 3 GB, the two models about 21 GB).

## Features

### AI writing help

- **Live checking**: when you pause typing, changed paragraphs are checked, starting with the one at the cursor.
- **Confirm before replacing**: click an underline to see the original, the suggestion and the reason.
- **Improve** (`Ctrl+Shift+I`): rewrites the selected text, or the current paragraph, to be clearer and richer.
- **Rewrite doc**: rewrites the whole document with a larger model. You review and tick each changed paragraph before anything is applied.
- **Writing styles**: ten built-in styles, from Elementary (Grade 3–5) to University, Professional lawyer, Professional scientist, Scholar, Business professional and Creative writer. Edit their prompts, add your own, or restore the built-in ones. One style is active for the whole app and every open window. A style can also ask for another language, such as a translation style.
- **Formatting is kept through AI changes**: formatted words are sent to the model with numbered tags, which it carries over to the matching words of its answer.
- **Change history** (`Ctrl+H`): every accepted AI change is listed, and any one of them can be undone later, even after more editing.

### Editor

- Bold, italic, underline, strikethrough; English and Chinese fonts; sizes; headings; lists; quotes; alignment.
- **Images (JPG, PNG)**: insert, paste or drag in. Choose how text wraps, as in Word: *In line*, *Square*, *Tight*, *Through*, *Top & bottom*, *Behind text*, *In front of text*.
  - **Align** an image Top / Middle / Bottom against the letters of its line or paragraph.
  - Exact sizes and margins in pixels.
  - A movable image toolbar.
  - Images are embedded in the document, or linked to the file on disk.
- **View zoom**: 50%–300%, Page width or Whole page.
- **Interface language**: English or Traditional Chinese (繁體中文), switched with the 中文 / EN button.

### Files

- Saves as **`.awd`** (keeps the text, formatting and change history), with an autosaved recovery copy.
- Opens `.awd`, **Word (`.docx`)**, Markdown and text. Word files keep their headings, lists, fonts and images with their wrap settings.
- Exports to **PDF, Word, Rich Text, Markdown and plain text**.

### Ollama handling

- At start, Assist Writer starts Ollama if it is installed but not running, and loads the checking model so the first check is quick.
- When Assist Writer closes, it unloads its models to free the graphics memory. If it started Ollama, it stops Ollama too. An Ollama you started yourself keeps running.

## Web version: use it from other devices

1. Run `Start Assist Writer Web.bat` (or `Run Assist Writer (Web).bat` from the source) on the PC that runs Ollama. It lists the network addresses, such as `http://192.168.0.34:5178`.
2. On that PC, open **⚙ Settings → Network access** and set a password. Other devices can't log in until you do.
3. On a phone or laptop on the same network, open the address and log in.

The desktop app and the web version share settings, writing styles and documents (`Documents\Assist Writer`).

## Build from source

You need [Node.js](https://nodejs.org) 20 or newer, and [Rust](https://rustup.rs) with the Visual Studio C++ build tools.

```bash
git clone https://github.com/Garionhk/Assist-Writer.git
cd Assist-Writer
npm install
```

- **Run it:** double-click `Run Assist Writer.bat`, or `Run Assist Writer (Web).bat` for the web version. They rebuild when the code has changed.
- **Make the installer, portable app and web package:** double-click **`Build Dist.bat`**. It checks the code and runs the tests first, then puts everything in `dist/`.

Other commands:

```bash
npm run app:dev      # desktop app, debug build
npm test             # TypeScript tests
npm run test:rust    # Rust tests
npm run typecheck
npm run dist         # what Build Dist.bat runs after the checks
npm run icon         # regenerate all icons from build/icon.svg
npm run bench        # compare Ollama models on Assist Writer's real tasks
```

### Model benchmark

Measured with `npm run bench` on an RTX A4000 (16 GB) with Ollama 0.35.1, using the app's real prompts on English and Chinese text with planted mistakes:

| Model | Size | On GPU | Tokens/s | Check 1 paragraph | Improve | Rewrite 5 paragraphs | Fixed (check · rewrite) |
|---|---|---|---|---|---|---|---|
| `qwen3.5:9b` | 6.6 GB | 100% | 58.5 | 3.5 s | 1.3 s | 8.2 s | 9/9 · 9/9 |
| `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL` | 13.1 GB | 100% | 23.0 | 7.9 s | 4.4 s | 15.4 s | 8/9 · 9/9 |
| `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-IQ4_XS` | 14.3 GB | 95% | 17.5 | 9.0 s | 4.6 s | 21.1 s | 8/9 · 9/9 |
| `huihui_ai/Qwen3.8-abliterated:27b` | 17 GB | 72% | 10.2 | 16.4 s | 7.4 s | 47.2 s | 9/9 · 9/9 |

A model that doesn't fully fit in graphics memory slows down sharply. Checking several paragraphs in one request was 40–75% slower than one at a time, so the app checks one paragraph per request.

### Project layout

```
crates/core/    Rust library shared by the app and the server: settings, documents library,
                recovery, Ollama client, Ollama setup (install, start/stop, models, VRAM), PDF
crates/server/  Web version (axum): API, login and password, static files
src-tauri/      Desktop app (Tauri v2): commands, file dialogs, menu, start-up and exit
src/renderer/   React UI shared by both: TipTap editor, suggestions, history, dialogs,
                interface translations (i18n.zh-Hant.ts)
src/shared/     Types, writing styles, model sizes, Word reader, and the DOCX / RTF /
                Markdown / TXT exporters
scripts/        Benchmark, icon and packaging helpers
build/          icon.svg (the source of all icons), generated icons, installer message
```

### The `.awd` format

`.awd` is JSON: the document (TipTap/ProseMirror JSON), the list of accepted AI changes, the ignored suggestions, and timestamps. Text inserted by an AI change carries an invisible `aiChange` mark with the change's id; that is how a single change can be found and undone later. Other formats can't store this, so they are export targets.

## License

[Apache License 2.0](LICENSE).

Assist Writer uses Ollama and open models but doesn't include them. Each model has its own license; check it before using the model's output commercially.
