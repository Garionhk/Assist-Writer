//! Setting up and running Ollama for Assist Writer: finding and installing Ollama, starting
//! it when it isn't running (and stopping it again if we started it), the graphics card's
//! memory, and downloading models.
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::ollama::NdjsonParser;

/// Ollama's Windows installer (per-user, no admin rights needed).
pub const OLLAMA_INSTALLER_URL: &str = "https://ollama.com/download/OllamaSetup.exe";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command that runs without flashing a console window.
fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn trim_url(url: &str) -> &str {
    url.trim_end_matches('/')
}

/// Where Ollama is installed: on the PATH, or in its usual install folders.
pub fn find_ollama() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "ollama.exe" } else { "ollama" };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs").join("Ollama").join(exe));
    }
    for var in ["ProgramFiles", "ProgramW6432"] {
        if let Some(pf) = std::env::var_os(var) {
            candidates.push(PathBuf::from(pf).join("Ollama").join(exe));
        }
    }
    if !cfg!(windows) {
        candidates.extend(["/usr/local/bin/ollama", "/usr/bin/ollama", "/opt/homebrew/bin/ollama"].map(PathBuf::from));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Ollama's version if it answers at `url`, else None.
pub async fn running_version(client: &reqwest::Client, url: &str) -> Option<String> {
    let res = client.get(format!("{}/api/version", trim_url(url))).timeout(Duration::from_secs(2)).send().await.ok()?;
    let body: serde_json::Value = res.json().await.ok()?;
    Some(body["version"].as_str().unwrap_or("?").to_string())
}

/// `host:port` for OLLAMA_HOST, when the address is this PC (Ollama can only be started here).
fn local_host_port(url: &str) -> Option<String> {
    let rest = url.trim().trim_end_matches('/').split("://").nth(1).unwrap_or(url);
    let host_port = rest.split('/').next()?;
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h, p),
        _ => (host_port, "11434"),
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0").then(|| format!("{}:{port}", if host == "localhost" { "127.0.0.1" } else { host }))
}

/// True if a models folder holds at least one downloaded model (a file under manifests/).
fn has_models(dir: &std::path::Path) -> bool {
    fn any_file(dir: &std::path::Path, depth: u32) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        entries.flatten().any(|e| {
            let p = e.path();
            if p.is_file() { true } else { depth < 6 && p.is_dir() && any_file(&p, depth + 1) }
        })
    }
    any_file(&dir.join("manifests"), 0)
}

/// The models folder for an Ollama server we start. Ollama's own app keeps a "model location"
/// setting that overrides OLLAMA_MODELS, so OLLAMA_MODELS can name an empty folder while the
/// models are in Ollama's default folder: use the one that actually holds models (OLLAMA_MODELS
/// first), else OLLAMA_MODELS or the default for a fresh install.
fn models_dir() -> Option<PathBuf> {
    let env = std::env::var_os("OLLAMA_MODELS").filter(|v| !v.is_empty()).map(PathBuf::from);
    let default = dirs::home_dir().map(|h| h.join(".ollama").join("models"));
    [env.clone(), default.clone()].into_iter().flatten().find(|d| has_models(d)).or(env).or(default)
}

/// The Ollama server Assist Writer started itself (it's stopped again when the app closes).
static STARTED: Mutex<Option<u32>> = Mutex::new(None);

/// True if Assist Writer started the running Ollama server.
pub fn started_by_us() -> bool {
    STARTED.lock().map(|s| s.is_some()).unwrap_or(false)
}

/// What `ensure_running` found or did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaState {
    pub installed: bool,
    pub running: bool,
    /// Assist Writer started this Ollama server and will stop it on exit.
    pub started_by_app: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Makes sure Ollama answers at `url`: if it isn't running and is installed (and `url` is on
/// this PC), starts `ollama serve` in the background and waits for it (up to 30 s).
pub async fn ensure_running(client: &reqwest::Client, url: &str) -> OllamaState {
    let path = find_ollama();
    let mut state = OllamaState {
        installed: path.is_some(),
        running: false,
        started_by_app: started_by_us(),
        version: None,
        path: path.as_ref().map(|p| p.display().to_string()),
    };
    if let Some(v) = running_version(client, url).await {
        state.running = true;
        state.version = Some(v);
        return state;
    }
    let (Some(exe), Some(host)) = (path, local_host_port(url)) else { return state };
    let mut cmd = hidden(&exe);
    cmd.arg("serve").env("OLLAMA_HOST", &host);
    if let Some(dir) = models_dir() {
        cmd.env("OLLAMA_MODELS", dir);
    }
    let spawned = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(child) = spawned else { return state };
    if let Ok(mut s) = STARTED.lock() {
        *s = Some(child.id());
    }
    state.started_by_app = true;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(v) = running_version(client, url).await {
            state.running = true;
            state.version = Some(v);
            break;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    state
}

/// Stops the Ollama server Assist Writer started (with the model runners it started), if any.
pub fn stop_started() {
    let pid = STARTED.lock().ok().and_then(|mut s| s.take());
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        let _ = hidden("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

/// A graphics card and its memory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    pub vram_bytes: u64,
}

/// The graphics cards and their memory: from nvidia-smi for NVIDIA cards (exact), otherwise
/// from the display driver's registry entries (Windows; any vendor).
pub fn gpus() -> Vec<Gpu> {
    let mut out = Vec::new();
    if let Ok(o) = hidden("nvidia-smi").args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]).output() {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some((name, mib)) = line.rsplit_once(',') {
                if let Ok(mib) = mib.trim().parse::<u64>() {
                    out.push(Gpu { name: name.trim().to_string(), vram_bytes: mib * 1024 * 1024 });
                }
            }
        }
    }
    #[cfg(windows)]
    if out.is_empty() {
        out = registry_gpus();
    }
    out
}

#[cfg(windows)]
fn registry_gpus() -> Vec<Gpu> {
    // Display adapters: each has a DriverDesc and (for cards with their own memory) a 64-bit
    // HardwareInformation.qwMemorySize.
    const KEY: &str = r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(o) = hidden("reg").args(["query", KEY, "/s"]).output() else { return Vec::new() };
    let text = String::from_utf8_lossy(&o.stdout);
    let mut out = Vec::new();
    let (mut name, mut mem) = (None::<String>, None::<u64>);
    let flush = |name: &mut Option<String>, mem: &mut Option<u64>, out: &mut Vec<Gpu>| {
        if let (Some(n), Some(m)) = (name.take(), mem.take()) {
            if m > 0 && !out.iter().any(|g: &Gpu| g.name == n) {
                out.push(Gpu { name: n, vram_bytes: m });
            }
        }
        *name = None;
        *mem = None;
    };
    for line in text.lines() {
        if line.starts_with("HKEY_") {
            flush(&mut name, &mut mem, &mut out);
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[0] == "DriverDesc" {
            name = Some(parts[2..].join(" "));
        } else if parts.len() >= 3 && parts[0] == "HardwareInformation.qwMemorySize" {
            mem = u64::from_str_radix(parts[2].trim_start_matches("0x"), 16).ok();
        }
    }
    flush(&mut name, &mut mem, &mut out);
    out
}

/// Progress of a download or install step.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

/// Downloads Ollama's installer and runs it silently (it installs for this user, and starts
/// Ollama). Returns when the installer has finished.
pub async fn install_ollama(client: &reqwest::Client, cancel: CancellationToken, mut on_progress: impl FnMut(Progress)) -> Result<()> {
    let dir = std::env::temp_dir().join("assist-writer-setup");
    tokio::fs::create_dir_all(&dir).await?;
    let file = dir.join("OllamaSetup.exe");
    let res = client.get(OLLAMA_INSTALLER_URL).send().await.context("Could not reach ollama.com")?;
    if !res.status().is_success() {
        bail!("ollama.com responded {}", res.status().as_u16());
    }
    let total = res.content_length().unwrap_or(0);
    let mut out = tokio::fs::File::create(&file).await?;
    let mut done = 0u64;
    let mut last = Instant::now();
    let mut stream = res.bytes_stream();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => bail!("cancelled"),
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        out.write_all(&chunk).await?;
        done += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(200) {
            last = Instant::now();
            on_progress(Progress { status: "downloading".into(), completed: done, total });
        }
    }
    out.flush().await?;
    drop(out);
    on_progress(Progress { status: "installing".into(), completed: total, total });
    let installer = file.clone();
    let status = tokio::task::spawn_blocking(move || {
        hidden(&installer).args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]).status()
    })
    .await??;
    let _ = tokio::fs::remove_file(&file).await;
    if !status.success() {
        bail!("The Ollama installer stopped with code {}", status.code().unwrap_or(-1));
    }
    if find_ollama().is_none() {
        bail!("Ollama was installed but can't be found. Restart Assist Writer and try again.");
    }
    Ok(())
}

/// Downloads a model into Ollama, reporting progress. Already downloaded models finish quickly.
pub async fn pull_model(client: &reqwest::Client, url: &str, model: &str, cancel: CancellationToken, mut on_progress: impl FnMut(Progress)) -> Result<()> {
    let res = client
        .post(format!("{}/api/pull", trim_url(url)))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .context("Ollama is not running")?;
    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        bail!("Could not download {model}: {}", text.trim());
    }
    let mut parser = NdjsonParser::default();
    let mut stream = res.bytes_stream();
    let mut last = Instant::now() - Duration::from_secs(1);
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => bail!("cancelled"),
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break };
        for v in parser.feed(&chunk?) {
            if let Some(e) = v["error"].as_str() {
                return Err(anyhow!("Could not download {model}: {e}"));
            }
            let status = v["status"].as_str().unwrap_or_default().to_string();
            let done = status == "success";
            if done || last.elapsed() > Duration::from_millis(200) {
                last = Instant::now();
                on_progress(Progress {
                    status,
                    completed: v["completed"].as_u64().unwrap_or(0),
                    total: v["total"].as_u64().unwrap_or(0),
                });
            }
            if done {
                return Ok(());
            }
        }
    }
    bail!("The download of {model} stopped before it finished")
}

/// The size of each installed model (bytes), by name.
pub async fn installed_sizes(client: &reqwest::Client, url: &str) -> Result<Vec<(String, u64)>> {
    let body: serde_json::Value = client.get(format!("{}/api/tags", trim_url(url))).timeout(Duration::from_secs(5)).send().await?.json().await?;
    Ok(body["models"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| Some((m["name"].as_str()?.to_string(), m["size"].as_u64().unwrap_or(0)))).collect())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_ollama_only_for_this_pc() {
        assert_eq!(local_host_port("http://localhost:11434").as_deref(), Some("127.0.0.1:11434"));
        assert_eq!(local_host_port("http://127.0.0.1:11555/").as_deref(), Some("127.0.0.1:11555"));
        assert_eq!(local_host_port("http://localhost").as_deref(), Some("127.0.0.1:11434"));
        assert_eq!(local_host_port("http://192.168.1.5:11434"), None);
    }

    /// Run by hand: cargo test -p assist-core prints_gpus -- --ignored --nocapture
    #[test]
    #[ignore]
    fn prints_gpus() {
        println!("nvidia-smi / driver: {:?}", gpus());
        #[cfg(windows)]
        println!("registry: {:?}", registry_gpus());
        println!("ollama: {:?}", find_ollama());
        println!("models folder: {:?}", models_dir());
    }
}
