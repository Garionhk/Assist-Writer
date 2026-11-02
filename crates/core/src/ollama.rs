//! Client for the local Ollama server.
use anyhow::{anyhow, bail, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// One chat request, as sent by the UI (`ChatRequest` in src/shared/types.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub request_id: String,
    pub model: String,
    pub messages: Vec<Value>,
    pub schema: Option<Value>,
    pub temperature: Option<f64>,
    pub num_ctx: Option<u32>,
    pub max_tokens: Option<u32>,
    pub keep_alive: Option<Value>,
    pub stream: Option<bool>,
}

/// A model Ollama has in memory, and how much of it is in GPU memory (bytes).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModel {
    pub name: String,
    pub size: u64,
    pub size_vram: u64,
}

/// Splits Ollama's streamed answer (one JSON object per line) into objects. Bytes are kept
/// until a whole line has arrived, so a character split across network packets stays intact.
#[derive(Default)]
pub struct NdjsonParser {
    buf: Vec<u8>,
}

impl NdjsonParser {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Value> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            if !text.is_empty() {
                if let Ok(v) = serde_json::from_str::<Value>(text) {
                    out.push(v);
                }
            }
        }
        out
    }
}

fn trim_url(url: &str) -> &str {
    url.trim_end_matches('/')
}

pub struct Ollama {
    client: reqwest::Client,
    inflight: Mutex<HashMap<String, CancellationToken>>,
}

impl Default for Ollama {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).build().expect("http client"),
            inflight: Mutex::new(HashMap::new()),
        }
    }
}

impl Ollama {
    pub async fn list_models(&self, url: &str) -> Result<Vec<String>> {
        let res = self.client.get(format!("{}/api/tags", trim_url(url))).timeout(Duration::from_secs(5)).send().await?;
        if !res.status().is_success() {
            bail!("Ollama responded {}", res.status().as_u16());
        }
        let body: Value = res.json().await?;
        let mut names: Vec<String> = body["models"]
            .as_array()
            .map(|a| a.iter().filter_map(|m| m["name"].as_str().map(String::from)).collect())
            .unwrap_or_default();
        names.sort();
        Ok(names)
    }

    pub async fn loaded_models(&self, url: &str) -> Result<Vec<LoadedModel>> {
        let body: Value = self.client.get(format!("{}/api/ps", trim_url(url))).timeout(Duration::from_secs(5)).send().await?.json().await?;
        Ok(body["models"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|m| LoadedModel {
                        name: m["name"].as_str().unwrap_or_default().to_string(),
                        size: m["size"].as_u64().unwrap_or(0),
                        size_vram: m["size_vram"].as_u64().unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Frees a model's memory right away.
    pub async fn unload(&self, url: &str, model: &str) -> Result<()> {
        self.client.post(format!("{}/api/generate", trim_url(url))).json(&json!({ "model": model, "keep_alive": 0 })).send().await?;
        Ok(())
    }

    /// Loads a model without generating anything. `num_ctx` must match later requests,
    /// or Ollama loads the model a second time.
    pub async fn warm_up(&self, url: &str, model: &str, num_ctx: Option<u32>) -> Result<()> {
        let mut body = json!({ "model": model, "keep_alive": "30m" });
        if let Some(n) = num_ctx {
            body["options"] = json!({ "num_ctx": n });
        }
        let res = self.client.post(format!("{}/api/generate", trim_url(url))).json(&body).send().await?;
        if !res.status().is_success() {
            bail!("Could not load {model} (Ollama {})", res.status().as_u16());
        }
        Ok(())
    }

    /// The HTTP client (shared with the setup steps).
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// A cancel token for a long request (see `cancel`); call `finish` when it's done.
    pub fn track(&self, request_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.inflight.lock().unwrap().insert(request_id.to_string(), token.clone());
        token
    }

    pub fn finish(&self, request_id: &str) {
        self.inflight.lock().unwrap().remove(request_id);
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(token) = self.inflight.lock().unwrap().remove(request_id) {
            token.cancel();
        }
    }

    /// Sends a chat request and returns the full answer. Streamed text is also passed to
    /// `on_chunk` as it arrives. Cancelling (see `cancel`) ends it with the error "cancelled".
    pub async fn chat(&self, url: &str, req: &ChatRequest, mut on_chunk: impl FnMut(&str) + Send) -> Result<String> {
        let token = CancellationToken::new();
        self.inflight.lock().unwrap().insert(req.request_id.clone(), token.clone());
        let result = tokio::select! {
            _ = token.cancelled() => Err(anyhow!("cancelled")),
            r = async {
                match self.chat_once(url, req, &mut on_chunk, true).await {
                    // Models without a thinking mode reject the `think` flag; retry without it.
                    Err(e) if e.to_string().to_lowercase().contains("think") => self.chat_once(url, req, &mut on_chunk, false).await,
                    other => other,
                }
            } => r,
        };
        self.inflight.lock().unwrap().remove(&req.request_id);
        result
    }

    async fn chat_once(&self, url: &str, req: &ChatRequest, on_chunk: &mut (impl FnMut(&str) + Send), send_think: bool) -> Result<String> {
        let mut options = Map::new();
        options.insert("temperature".into(), json!(req.temperature.unwrap_or(0.3)));
        if let Some(n) = req.num_ctx {
            options.insert("num_ctx".into(), json!(n));
        }
        if let Some(n) = req.max_tokens {
            options.insert("num_predict".into(), json!(n));
        }
        let stream = req.stream.unwrap_or(false);
        let mut body = json!({
            "model": req.model,
            "messages": req.messages,
            "stream": stream,
            "options": options,
            "keep_alive": req.keep_alive.clone().unwrap_or(json!("30m")),
        });
        if let Some(schema) = &req.schema {
            body["format"] = schema.clone();
        }
        // Thinking makes the model far slower; writing help doesn't need it.
        if send_think {
            body["think"] = json!(false);
        }

        let res = self
            .client
            .post(format!("{}/api/chat", trim_url(url)))
            .json(&body)
            .send()
            .await
            .map_err(|_| anyhow!("Cannot reach Ollama at {url}. Is it running?"))?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let text = res.text().await.unwrap_or_default();
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["error"].as_str().map(String::from))
                .unwrap_or(text);
            bail!("Ollama error ({status}): {message}");
        }

        if !stream {
            let v: Value = res.json().await?;
            return Ok(v["message"]["content"].as_str().unwrap_or_default().to_string());
        }
        let mut parser = NdjsonParser::default();
        let mut full = String::new();
        let mut bytes = res.bytes_stream();
        while let Some(chunk) = bytes.next().await {
            for part in parser.feed(&chunk?) {
                if let Some(err) = part["error"].as_str() {
                    bail!("Ollama error: {err}");
                }
                if let Some(text) = part["message"]["content"].as_str().filter(|t| !t.is_empty()) {
                    full.push_str(text);
                    on_chunk(text);
                }
            }
        }
        Ok(full)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lines_split_across_packets() {
        let mut p = NdjsonParser::default();
        let line = "{\"message\":{\"content\":\"你好\"}}\n{\"done\":true}\n";
        let bytes = line.as_bytes();
        // Split in the middle of the 3-byte character 你.
        let cut = line.find('你').unwrap() + 1;
        assert!(p.feed(&bytes[..cut]).is_empty());
        let out = p.feed(&bytes[cut..]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["message"]["content"], "你好");
        assert_eq!(out[1]["done"], true);
    }

    #[test]
    fn reads_chat_requests_from_the_ui() {
        let req: ChatRequest = serde_json::from_value(json!({
            "requestId": "check-1", "model": "qwen3.5:9b", "messages": [{"role": "user", "content": "hi"}],
            "numCtx": 8192, "maxTokens": 1200, "keepAlive": 0, "stream": true
        }))
        .unwrap();
        assert_eq!(req.num_ctx, Some(8192));
        assert_eq!(req.max_tokens, Some(1200));
        assert_eq!(req.keep_alive, Some(json!(0)));
    }
}
