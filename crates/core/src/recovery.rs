//! Crash recovery: a copy of unsaved work, offered again when the app next starts.
use anyhow::Result;
use serde_json::{json, Value};
use std::path::PathBuf;

fn recovery_file() -> PathBuf {
    crate::paths::data_dir().join("recovery").join("recovery.json")
}

pub fn save(data: Value, path: Option<String>) -> Result<()> {
    let file = recovery_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = json!({ "data": data, "path": path, "savedAt": crate::now_iso() });
    std::fs::write(file, serde_json::to_string(&body)?)?;
    Ok(())
}

/// `{ data, path, savedAt }`, or None when there is nothing to recover.
pub fn load() -> Option<Value> {
    let text = std::fs::read_to_string(recovery_file()).ok()?;
    serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok()
}

pub fn clear() -> Result<()> {
    match std::fs::remove_file(recovery_file()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}
