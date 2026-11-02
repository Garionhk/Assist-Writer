//! HTML → PDF using the Edge (or Chrome) already on the PC, so fonts — including Chinese —
//! are embedded exactly as the editor shows them.
use anyhow::{anyhow, bail, Result};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn find_browser() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let pf = env("ProgramFiles").unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let pf86 = env("ProgramFiles(x86)").unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    let local = env("LOCALAPPDATA").unwrap_or_default();
    [
        env("ASSIST_WRITER_BROWSER"),
        Some(pf86.join(r"Microsoft\Edge\Application\msedge.exe")),
        Some(pf.join(r"Microsoft\Edge\Application\msedge.exe")),
        Some(pf.join(r"Google\Chrome\Application\chrome.exe")),
        Some(pf86.join(r"Google\Chrome\Application\chrome.exe")),
        Some(local.join(r"Google\Chrome\Application\chrome.exe")),
    ]
    .into_iter()
    .flatten()
    .find(|p| p.is_file())
}

pub async fn html_to_pdf(html: &str) -> Result<Vec<u8>> {
    let browser = find_browser().ok_or_else(|| anyhow!("PDF export needs Microsoft Edge or Google Chrome installed."))?;
    let dir = tempfile::Builder::new().prefix("assist-writer-pdf-").tempdir()?;
    let html_path = dir.path().join("doc.html");
    let pdf_path = dir.path().join("doc.pdf");
    tokio::fs::write(&html_path, html).await?;
    let url = format!("file:///{}", html_path.display().to_string().replace('\\', "/"));

    let mut cmd = tokio::process::Command::new(browser);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--no-pdf-header-footer",
    ])
    .arg(format!("--user-data-dir={}", dir.path().join("profile").display()))
    .arg(format!("--print-to-pdf={}", pdf_path.display()))
    .arg(url)
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn()?;
    let _ = tokio::time::timeout(Duration::from_secs(60), child.wait()).await;

    // msedge.exe can hand the work to another process and exit before the PDF is written,
    // so wait until the file exists and its size has stopped changing.
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut last = 0u64;
    while Instant::now() < deadline {
        let size = tokio::fs::metadata(&pdf_path).await.map(|m| m.len()).unwrap_or(0);
        if size > 0 && size == last {
            return Ok(tokio::fs::read(&pdf_path).await?);
        }
        last = size;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    bail!("PDF export failed.")
}
