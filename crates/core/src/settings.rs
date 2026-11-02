//! Settings are stored as the JSON the UI saves. Defaults (models, the 10 writing styles…)
//! live in the UI, which merges them in, so this side never goes out of sync with them.
use anyhow::Result;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";

fn settings_path() -> PathBuf {
    crate::paths::data_dir().join("settings.json")
}

/// Parses settings JSON, tolerating a byte-order mark. Anything unreadable counts as empty.
pub fn parse(text: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

pub fn load_from(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path).map(|t| parse(&t)).unwrap_or_default()
}

/// The saved settings (an empty object when nothing has been saved yet).
pub fn load() -> Map<String, Value> {
    load_from(&settings_path())
}

/// Saves settings, keeping any fields the new value doesn't mention.
pub fn save(new: Map<String, Value>) -> Result<Map<String, Value>> {
    let path = settings_path();
    let mut merged = load_from(&path);
    merged.extend(new);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&merged)?)?;
    Ok(merged)
}

/// When the settings file was last changed (None if it doesn't exist yet). Used to notice
/// changes made by another window — the desktop app, the web version or another device.
pub fn modified() -> Option<std::time::SystemTime> {
    std::fs::metadata(settings_path()).and_then(|m| m.modified()).ok()
}

/// Calls `on_change` whenever the settings file changes, checking every 1.5 s, on a
/// background thread, for as long as the program runs.
pub fn watch(on_change: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        let mut last = modified();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let now = modified();
            if now != last {
                last = now;
                on_change();
            }
        }
    });
}

/// The Ollama address from saved settings, or the default.
pub fn ollama_url() -> String {
    load()
        .get("ollamaUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_OLLAMA_URL)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tolerates_bom_and_garbage() {
        let m = parse("\u{feff}{\"liveCheck\": true, \"ollamaUrl\": \"http://x:1\"}");
        assert_eq!(m.get("liveCheck"), Some(&Value::Bool(true)));
        assert!(parse("not json").is_empty());
        assert!(parse("[1,2]").is_empty());
    }

    #[test]
    fn keeps_chinese_text_intact() {
        let m = parse("{\"name\":\"Elementary (Grade 3–5)\",\"p\":\"小学三至五年级\"}");
        assert_eq!(m["name"], "Elementary (Grade 3–5)");
        assert_eq!(m["p"], "小学三至五年级");
    }
}
