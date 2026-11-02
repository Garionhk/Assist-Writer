// Assist Writer desktop app (Tauri). The UI is the same React editor as the web version;
// this file provides `window.api` for it through Tauri commands (see src/renderer/src/tauriApi.ts).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use assist_core::{
    ollama::{ChatRequest, LoadedModel, Ollama},
    paths, pdf, recovery, settings,
    setup::{self, Gpu, OllamaState, Progress},
};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::ipc::{Channel, Response};
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

struct AppState {
    ollama: Ollama,
    dirty: AtomicBool,
    initial_file: Mutex<Option<String>>,
    /** Interface language: the menu and prompts follow the UI (see `set_language`). */
    chinese: AtomicBool,
}

/// English or Traditional Chinese text, by the interface language.
fn tr(state: &AppState, en: &'static str, zh: &'static str) -> &'static str {
    if state.chinese.load(Ordering::SeqCst) { zh } else { en }
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const OPENABLE: &[&str] = &["awd", "docx", "md", "markdown", "txt"];

fn extension(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase()
}

// ---- Settings and Ollama ---------------------------------------------------------------

#[tauri::command]
fn get_settings() -> Map<String, Value> {
    settings::load()
}

#[tauri::command]
fn save_settings(values: Map<String, Value>) -> CmdResult<Map<String, Value>> {
    settings::save(values).map_err(err)
}

#[tauri::command]
async fn list_models(state: State<'_, AppState>, url: Option<String>) -> CmdResult<Vec<String>> {
    let url = url.filter(|u| !u.is_empty()).unwrap_or_else(settings::ollama_url);
    state.ollama.list_models(&url).await.map_err(err)
}

/// Streams partial text to the UI through `on_chunk` and returns the full answer.
#[tauri::command]
async fn chat(state: State<'_, AppState>, req: ChatRequest, on_chunk: Channel<String>) -> CmdResult<String> {
    state
        .ollama
        .chat(&settings::ollama_url(), &req, |text| {
            let _ = on_chunk.send(text.to_string());
        })
        .await
        .map_err(err)
}

#[tauri::command]
fn cancel_chat(state: State<'_, AppState>, request_id: String) {
    state.ollama.cancel(&request_id);
}

#[tauri::command]
async fn warm_up(state: State<'_, AppState>, model: String, num_ctx: Option<u32>) -> CmdResult<()> {
    state.ollama.warm_up(&settings::ollama_url(), &model, num_ctx).await.map_err(err)
}

#[tauri::command]
async fn unload_model(state: State<'_, AppState>, model: String) -> CmdResult<()> {
    state.ollama.unload(&settings::ollama_url(), &model).await.map_err(err)
}

#[tauri::command]
async fn loaded_models(state: State<'_, AppState>) -> CmdResult<Vec<LoadedModel>> {
    state.ollama.loaded_models(&settings::ollama_url()).await.map_err(err)
}

// ---- Setup: Ollama and models -----------------------------------------------------------------

/// Starts Ollama if it's installed but not running (it's stopped again when the app closes).
#[tauri::command]
async fn ensure_ollama(state: State<'_, AppState>) -> CmdResult<OllamaState> {
    Ok(setup::ensure_running(state.ollama.client(), &settings::ollama_url()).await)
}

/// What the Setup window shows: Ollama, the graphics cards, and the installed models' sizes.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
    ollama: OllamaState,
    gpus: Vec<Gpu>,
    /// Installed models and their sizes (bytes).
    models: Vec<(String, u64)>,
}

#[tauri::command]
async fn setup_status(state: State<'_, AppState>) -> CmdResult<SetupStatus> {
    let url = settings::ollama_url();
    let ollama = setup::ensure_running(state.ollama.client(), &url).await;
    let models = if ollama.running { setup::installed_sizes(state.ollama.client(), &url).await.unwrap_or_default() } else { Vec::new() };
    let gpus = tauri::async_runtime::spawn_blocking(setup::gpus).await.unwrap_or_default();
    Ok(SetupStatus { ollama, gpus, models })
}

/// Downloads and installs Ollama; `request_id` can be cancelled with `cancel_chat`.
#[tauri::command]
async fn install_ollama(state: State<'_, AppState>, request_id: String, on_progress: Channel<Progress>) -> CmdResult<OllamaState> {
    let token = state.ollama.track(&request_id);
    let result = setup::install_ollama(state.ollama.client(), token, |p| {
        let _ = on_progress.send(p);
    })
    .await;
    state.ollama.finish(&request_id);
    result.map_err(err)?;
    Ok(setup::ensure_running(state.ollama.client(), &settings::ollama_url()).await)
}

/// Downloads a model into Ollama; `request_id` can be cancelled with `cancel_chat`.
#[tauri::command]
async fn pull_model(state: State<'_, AppState>, model: String, request_id: String, on_progress: Channel<Progress>) -> CmdResult<()> {
    let token = state.ollama.track(&request_id);
    let result = setup::pull_model(state.ollama.client(), &settings::ollama_url(), &model, token, |p| {
        let _ = on_progress.send(p);
    })
    .await;
    state.ollama.finish(&request_id);
    result.map_err(err)
}

/// On exit: frees the graphics memory our models use, and stops Ollama if we started it.
fn release_ollama(app: &AppHandle) {
    let state = app.state::<AppState>();
    let url = settings::ollama_url();
    let s = settings::load();
    let models: Vec<String> = ["liveModel", "rewriteModel"].iter().filter_map(|k| s.get(*k).and_then(Value::as_str).map(String::from)).collect();
    tauri::async_runtime::block_on(async {
        for m in &models {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), state.ollama.unload(&url, m)).await;
        }
    });
    setup::stop_started();
}

// ---- Files -------------------------------------------------------------------------------

fn library_dir() -> PathBuf {
    let dir = paths::library_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Asks for a file to open; the UI then reads it with `read_file` and converts it itself.
#[tauri::command]
async fn pick_open_file(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_directory(library_dir())
        .add_filter("All supported", OPENABLE)
        .add_filter("Assist Writer Document", &["awd"])
        .add_filter("Word Document", &["docx"])
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("Plain Text", &["txt"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

/// A JPG/PNG to insert into the document.
#[tauri::command]
async fn pick_image(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
async fn read_file(path: String) -> CmdResult<Response> {
    Ok(Response::new(std::fs::read(&path).map_err(err)?))
}

/// The file the app was launched with (e.g. a double-clicked .awd), once.
#[tauri::command]
fn initial_file(state: State<'_, AppState>) -> Option<String> {
    state.initial_file.lock().unwrap().take()
}

#[tauri::command]
async fn save_file(app: AppHandle, path: Option<String>, data: Value, save_as: bool) -> CmdResult<Option<String>> {
    let target = match path.filter(|p| !p.is_empty() && !save_as) {
        Some(p) => PathBuf::from(p),
        None => {
            let picked = app
                .dialog()
                .file()
                .set_directory(library_dir())
                .set_file_name("Untitled.awd")
                .add_filter("Assist Writer Document", &["awd"])
                .blocking_save_file()
                .and_then(|p| p.into_path().ok());
            let Some(mut p) = picked else { return Ok(None) };
            if extension(&p) != "awd" {
                p.set_extension("awd");
            }
            p
        }
    };
    std::fs::write(&target, serde_json::to_string(&data).map_err(err)?).map_err(err)?;
    Ok(Some(target.display().to_string()))
}

/// Saves an export. The UI produces the bytes for DOCX/RTF/MD/TXT; PDF is printed from HTML here.
#[tauri::command]
async fn export_file(app: AppHandle, format: String, name: String, bytes: Option<Vec<u8>>, html: Option<String>) -> CmdResult<Option<String>> {
    let label = match format.as_str() {
        "pdf" => "PDF",
        "docx" => "Word Document",
        "rtf" => "Rich Text Format",
        "md" => "Markdown",
        "txt" => "Plain Text",
        _ => return Err("Unknown export format.".into()),
    };
    let picked = app
        .dialog()
        .file()
        .set_directory(library_dir())
        .set_file_name(format!("{name}.{format}"))
        .add_filter(label, &[format.as_str()])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok());
    let Some(path) = picked else { return Ok(None) };
    let data = if format == "pdf" {
        pdf::html_to_pdf(&html.unwrap_or_default()).await.map_err(err)?
    } else {
        bytes.ok_or("Nothing to export.")?
    };
    std::fs::write(&path, data).map_err(err)?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
fn save_recovery(data: Value, path: Option<String>) -> CmdResult<()> {
    recovery::save(data, path).map_err(err)
}

#[tauri::command]
fn load_recovery() -> Option<Value> {
    recovery::load()
}

#[tauri::command]
fn clear_recovery() -> CmdResult<()> {
    recovery::clear().map_err(err)
}

// ---- Window ----------------------------------------------------------------------------------

#[tauri::command]
fn set_dirty(window: WebviewWindow, state: State<'_, AppState>, dirty: bool, title: String) {
    state.dirty.store(dirty, Ordering::SeqCst);
    let _ = window.set_title(&format!("{}{} — Assist Writer", if dirty { "● " } else { "" }, title));
}

/// Switches the menu and prompts to English (`en`) or Traditional Chinese (`zh-Hant`).
#[tauri::command]
fn set_language(app: AppHandle, state: State<'_, AppState>, lang: String) -> CmdResult<()> {
    let chinese = lang == "zh-Hant";
    if state.chinese.swap(chinese, Ordering::SeqCst) != chinese {
        app.set_menu(build_menu(&app).map_err(err)?).map_err(err)?;
    }
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<AppState>();
    let l = |en: &'static str, zh: &'static str| tr(&state, en, zh);
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, label);
        match accel {
            Some(a) => b.accelerator(a).build(app),
            None => b.build(app),
        }
    };
    let export = SubmenuBuilder::new(app, l("Export", "匯出"))
        .item(&item("export:pdf", "PDF (.pdf)…", None)?)
        .item(&item("export:docx", "Word (.docx)…", None)?)
        .item(&item("export:rtf", l("Rich Text (.rtf)…", "RTF 格式文字 (.rtf)…"), None)?)
        .item(&item("export:md", "Markdown (.md)…", None)?)
        .item(&item("export:txt", l("Plain Text (.txt)…", "純文字 (.txt)…"), None)?)
        .build()?;
    let file = SubmenuBuilder::new(app, l("&File", "檔案(&F)"))
        .item(&item("new", l("New", "新增"), Some("CmdOrCtrl+N"))?)
        .item(&item("open", l("Open…", "開啟…"), Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("save", l("Save", "儲存"), Some("CmdOrCtrl+S"))?)
        .item(&item("saveAs", l("Save As…", "另存新檔…"), Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&export)
        .separator()
        .item(&item("settings", l("Settings…", "設定…"), Some("CmdOrCtrl+Comma"))?)
        .separator()
        .item(&item("quit", l("Exit", "結束"), None)?)
        .build()?;
    // Undo/redo have no accelerators here, so Ctrl+Z / Ctrl+Y go to the editor itself.
    let edit = SubmenuBuilder::new(app, l("&Edit", "編輯(&E)"))
        .item(&item("undo", l("Undo", "復原"), None)?)
        .item(&item("redo", l("Redo", "取消復原"), None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(l("Cut", "剪下")))?)
        .item(&PredefinedMenuItem::copy(app, Some(l("Copy", "複製")))?)
        .item(&PredefinedMenuItem::paste(app, Some(l("Paste", "貼上")))?)
        .item(&PredefinedMenuItem::select_all(app, Some(l("Select All", "全選")))?)
        .build()?;
    let ai = SubmenuBuilder::new(app, l("&AI", "AI(&A)"))
        .item(&item("improve", l("Improve Selection (Ctrl+Shift+I)", "改善選取的文字 (Ctrl+Shift+I)"), None)?)
        .item(&item("rewrite", l("Rewrite Whole Document…", "改寫整份文件…"), None)?)
        .item(&item("checkAll", l("Check Whole Document Now", "立即檢查整份文件"), None)?)
        .separator()
        .item(&item("toggleLive", l("Toggle Live Checking", "開啟／關閉即時檢查"), None)?)
        .item(&item("history", l("Show Change History", "顯示修改記錄"), Some("CmdOrCtrl+H"))?)
        .separator()
        .item(&item("setup", l("Set Up Ollama and Models…", "設定 Ollama 和模型…"), None)?)
        .build()?;
    // Zoom is the page zoom in the UI (shown on the toolbar and remembered there).
    let view = SubmenuBuilder::new(app, l("&View", "檢視(&V)"))
        .item(&item("zoomIn", l("Zoom In", "放大"), Some("CmdOrCtrl+Equal"))?)
        .item(&item("zoomOut", l("Zoom Out", "縮小"), Some("CmdOrCtrl+Minus"))?)
        .item(&item("zoomReset", l("Actual Size (100%)", "實際大小 (100%)"), Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&item("fullscreen", l("Toggle Full Screen", "切換全螢幕"), Some("F11"))?)
        .item(&item("devtools", l("Developer Tools", "開發人員工具"), Some("F12"))?)
        .build()?;
    MenuBuilder::new(app).items(&[&file, &edit, &ai, &view]).build()
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    match id {
        "fullscreen" => {
            let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
        }
        "devtools" => {
            #[cfg(debug_assertions)]
            window.open_devtools();
        }
        "quit" => {
            let _ = window.close();
        }
        // Everything else is handled by the UI, exactly like the Electron menu did.
        other => {
            let _ = window.emit("menu", other);
        }
    }
}

/// A document given on the command line (double-clicking an .awd file).
fn launch_file() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        let p = Path::new(a);
        OPENABLE.contains(&extension(p).as_str()) && p.is_file()
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            ollama: Ollama::default(),
            dirty: AtomicBool::new(false),
            initial_file: Mutex::new(launch_file()),
            chinese: AtomicBool::new(false),
        })
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
            // Settings changed by another window (web version, another device): tell the UI.
            let handle = app.handle().clone();
            settings::watch(move || {
                let _ = handle.emit("settings-changed", ());
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing with unsaved changes asks first (a recovery copy is kept either way).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if !state.dirty.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let window = window.clone();
                // Standard Yes/No buttons: custom button labels need a dialog type that can
                // silently fail to appear on some Windows setups.
                window
                    .dialog()
                    .message(tr(
                        &state,
                        "You have unsaved changes. Close without saving?\n\nA recovery copy is kept and will be offered next time you open Assist Writer.",
                        "有未儲存的變更。要不儲存就關閉嗎？\n\n系統會保留一份復原副本，下次開啟 Assist Writer 時會提供給您。",
                    ))
                    .title(tr(&state, "Unsaved changes", "未儲存的變更"))
                    .kind(MessageDialogKind::Warning)
                    .parent(&window)
                    .buttons(MessageDialogButtons::YesNo)
                    .show(move |discard| {
                        if discard {
                            window.state::<AppState>().dirty.store(false, Ordering::SeqCst);
                            let _ = window.destroy();
                        }
                    });
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            list_models,
            chat,
            cancel_chat,
            warm_up,
            unload_model,
            loaded_models,
            pick_open_file,
            pick_image,
            read_file,
            initial_file,
            save_file,
            export_file,
            save_recovery,
            load_recovery,
            clear_recovery,
            set_dirty,
            set_language,
            ensure_ollama,
            setup_status,
            install_ollama,
            pull_model
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Assist Writer")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                release_ollama(app);
            }
        });
}
