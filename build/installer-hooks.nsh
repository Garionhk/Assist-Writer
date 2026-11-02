; Assist Writer installer hooks (see bundle.windows.nsis.installerHooks in src-tauri/tauri.conf.json).
; Saved as UTF-8 with a BOM so NSIS reads the Chinese text correctly.

!macro NSIS_HOOK_PREINSTALL
  ; Tell people what the AI needs before installing (not in silent installs), in Chinese on a
  ; Chinese Windows (primary language 0x04), else in English.
  IfSilent aw_vram_done
  System::Call 'kernel32::GetUserDefaultUILanguage() i.r0'
  IntOp $0 $0 & 0x3FF
  IntCmp $0 4 aw_vram_zh
    MessageBox MB_OK|MB_ICONINFORMATION "Assist Writer runs its AI models on this PC with Ollama (free).$\r$\n$\r$\nGraphics card memory (VRAM) needed:$\r$\n  • 16 GB recommended: checking while you type and rewriting whole documents both run fast.$\r$\n  • 8 GB minimum: checking while you type is fast; rewriting whole documents is slower.$\r$\n  • Less, or no graphics card: everything works, but slowly.$\r$\n$\r$\nWhen Assist Writer first opens, its Setup window shows your graphics card, installs Ollama and downloads the AI models (about 24 GB of disk space in all)."
    Goto aw_vram_done
  aw_vram_zh:
    MessageBox MB_OK|MB_ICONINFORMATION "Assist Writer 透過 Ollama（免費）在這台電腦上執行 AI 模型。$\r$\n$\r$\n所需的顯示卡記憶體 (VRAM)：$\r$\n  • 建議 16 GB：輸入時檢查和改寫整份文件都很快。$\r$\n  • 最少 8 GB：輸入時檢查很快；改寫整份文件比較慢。$\r$\n  • 更少或沒有顯示卡：所有功能都能使用，但比較慢。$\r$\n$\r$\nAssist Writer 第一次開啟時，設定視窗會顯示您的顯示卡、安裝 Ollama 並下載 AI 模型（共約需 24 GB 磁碟空間）。"
  aw_vram_done:
!macroend
