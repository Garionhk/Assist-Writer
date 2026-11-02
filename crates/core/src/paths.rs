use std::path::PathBuf;

/// Where settings and recovery copies live. Shared by the desktop app and the web server.
/// `ASSIST_WRITER_DATA` overrides it (tests use this so they never touch real settings).
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ASSIST_WRITER_DATA").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
        .join("assist-writer")
}

/// The documents library: a normal folder of .awd files the user can also browse.
pub fn library_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ASSIST_WRITER_LIBRARY").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::document_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Documents"))
        .join("Assist Writer")
}
