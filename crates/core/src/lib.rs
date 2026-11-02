//! Assist Writer core, shared by the desktop app (`src-tauri`) and the web server
//! (`crates/server`): settings, the documents library, crash recovery, the Ollama client
//! PDF printing, and setting up Ollama.

pub mod library;
pub mod ollama;
pub mod paths;
pub mod pdf;
pub mod recovery;
pub mod settings;
pub mod setup;

/// Current time as an ISO-8601 string (UTC, milliseconds), as the UI expects.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
