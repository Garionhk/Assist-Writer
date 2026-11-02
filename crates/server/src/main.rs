//! Assist Writer web version: serves the editor UI and the API it needs (Ollama, documents
//! library, PDF export) on this PC and, with a password, the local network.
//!   assist-writer-server [--port 5178] [--ui <folder with the built UI>]
mod auth;

use assist_core::{library::Library, ollama::{ChatRequest, Ollama}, paths, pdf, settings};
use auth::Auth;
use axum::body::{to_bytes, Body, Bytes};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

const MAX_BODY: usize = 60 * 1024 * 1024;

struct App {
    ollama: Ollama,
    library: Library,
    auth: Auth,
    port: u16,
    ui_dir: PathBuf,
    /// Fires when the settings file changes (from any window or device), for /api/events.
    settings_changed: tokio::sync::broadcast::Sender<()>,
}

/// A live stream that tells the browser whenever the settings change, so every open window
/// and device shows the same writing style. Comments are sent now and then to keep it open.
fn settings_events(app: &App) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    let rx = app.settings_changed.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        use tokio::sync::broadcast::error::RecvError;
        match rx.recv().await {
            Ok(()) | Err(RecvError::Lagged(_)) => Some((Ok::<_, std::convert::Infallible>(Event::default().event("settings").data("changed")), rx)),
            Err(RecvError::Closed) => None,
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// An error with the HTTP status to answer with; shown to the user as `{ "error": … }`.
struct HttpError(StatusCode, String);

impl HttpError {
    fn new(status: StatusCode, message: impl ToString) -> Self {
        Self(status, message.to_string())
    }
}

type ApiResult = Result<Response, HttpError>;

const SECURITY_HEADERS: &[(&str, &str)] = &[
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    (
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
    ),
];

fn with_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    for (k, v) in SECURITY_HEADERS {
        h.insert(*k, HeaderValue::from_static(v));
    }
    res
}

fn json_response(status: StatusCode, body: &Value) -> Response {
    let mut res = (status, body.to_string()).into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn ok(body: Value) -> ApiResult {
    Ok(json_response(StatusCode::OK, &body))
}

fn header_str<'a>(h: &'a HeaderMap, name: header::HeaderName) -> &'a str {
    h.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default()
}

/// Reads a JSON body. Requiring a JSON content type means plain cross-site form posts can't reach the API.
async fn read_json(headers: &HeaderMap, body: Body) -> Result<Value, HttpError> {
    if !header_str(headers, header::CONTENT_TYPE).contains("application/json") {
        return Err(HttpError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Expected JSON."));
    }
    let bytes = to_bytes(body, MAX_BODY).await.map_err(|_| HttpError::new(StatusCode::PAYLOAD_TOO_LARGE, "File too large."))?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::new(StatusCode::BAD_REQUEST, "Invalid JSON."))
}

fn str_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Streams a chat as newline-delimited JSON: {"chunk":…}* then {"result":…} or {"error":…}.
/// The browser aborting the request (Cancel, page closed) cancels the Ollama request.
fn chat_stream(app: Arc<App>, req: ChatRequest) -> Response {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    let line = |v: Value| Bytes::from(format!("{v}\n"));
    let id = req.request_id.clone();
    {
        let (app, tx) = (app.clone(), tx.clone());
        tokio::spawn(async move {
            tx.closed().await;
            app.ollama.cancel(&id);
        });
    }
    tokio::spawn(async move {
        let chunk_tx = tx.clone();
        let result = app
            .ollama
            .chat(&settings::ollama_url(), &req, move |text| {
                let _ = chunk_tx.send(line(json!({ "chunk": text })));
            })
            .await;
        let _ = tx.send(line(match result {
            Ok(text) => json!({ "result": text }),
            Err(e) => json!({ "error": e.to_string() }),
        }));
    });
    let stream = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx).map(|o| o.map(Ok::<_, std::convert::Infallible>)));
    let mut res = Response::new(Body::from_stream(stream));
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-ndjson; charset=utf-8"));
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn api(app: Arc<App>, peer: SocketAddr, method: Method, path: &str, query: &str, headers: HeaderMap, body: Body) -> ApiResult {
    let host = header_str(&headers, header::HOST).to_string();
    let cookie = header_str(&headers, header::COOKIE).to_string();
    let bad = |e: anyhow::Error| HttpError::new(StatusCode::BAD_REQUEST, e);
    let conflict = |e: anyhow::Error| HttpError::new(StatusCode::CONFLICT, e);
    let server_err = |e: anyhow::Error| HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, e);

    // Endpoints available before logging in.
    match (&method, path) {
        (&Method::GET, "/api/session") => {
            return ok(json!({
                "authenticated": app.auth.is_authenticated(&peer, &host, &cookie),
                "isLocal": auth::is_local(&peer, &host),
                "passwordSet": auth::password_set(),
            }))
        }
        (&Method::POST, "/api/login") => {
            let body = read_json(&headers, body).await?;
            let set_cookie = app.auth.login(&peer, str_field(&body, "password")).map_err(|e| HttpError::new(StatusCode::UNAUTHORIZED, e))?;
            let mut res = json_response(StatusCode::OK, &json!({ "ok": true }));
            res.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&set_cookie).unwrap());
            return Ok(res);
        }
        (&Method::POST, "/api/logout") => {
            let mut res = json_response(StatusCode::OK, &json!({ "ok": true }));
            res.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&app.auth.logout(&cookie)).unwrap());
            return Ok(res);
        }
        _ => {}
    }

    if !app.auth.is_authenticated(&peer, &host, &cookie) {
        return Err(HttpError::new(StatusCode::UNAUTHORIZED, "Please log in."));
    }

    let url = settings::ollama_url();
    match (&method, path) {
        (&Method::GET, "/api/settings") => ok(Value::Object(settings::load())),
        (&Method::GET, "/api/events") => Ok(settings_events(&app)),
        (&Method::PUT, "/api/settings") => {
            let Value::Object(map) = read_json(&headers, body).await? else {
                return Err(HttpError::new(StatusCode::BAD_REQUEST, "Invalid settings."));
            };
            ok(Value::Object(settings::save(map).map_err(server_err)?))
        }
        (&Method::GET, "/api/models") => {
            let from_query = query.split('&').find_map(|kv| kv.strip_prefix("url=")).map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().to_string());
            let url = from_query.filter(|u| !u.is_empty()).unwrap_or(url);
            ok(json!(app.ollama.list_models(&url).await.map_err(server_err)?))
        }
        (&Method::POST, "/api/chat") => {
            let req: ChatRequest = serde_json::from_value(read_json(&headers, body).await?).map_err(|e| HttpError::new(StatusCode::BAD_REQUEST, e))?;
            Ok(chat_stream(app, req))
        }
        (&Method::POST, "/api/chat/cancel") => {
            app.ollama.cancel(str_field(&read_json(&headers, body).await?, "requestId"));
            ok(json!({ "ok": true }))
        }
        (&Method::POST, "/api/models/warm") => {
            let b = read_json(&headers, body).await?;
            let num_ctx = b.get("numCtx").and_then(Value::as_u64).map(|n| n as u32);
            app.ollama.warm_up(&url, str_field(&b, "model"), num_ctx).await.map_err(server_err)?;
            ok(json!({ "ok": true }))
        }
        (&Method::POST, "/api/models/unload") => {
            app.ollama.unload(&url, str_field(&read_json(&headers, body).await?, "model")).await.map_err(server_err)?;
            ok(json!({ "ok": true }))
        }
        (&Method::GET, "/api/models/loaded") => ok(json!(app.ollama.loaded_models(&url).await.map_err(server_err)?)),

        (&Method::GET, "/api/library") => ok(json!(app.library.list().map_err(server_err)?)),
        (&Method::PUT, "/api/library") => {
            let b = read_json(&headers, body).await?;
            let id = b.get("id").and_then(Value::as_str);
            let overwrite = b.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
            ok(json!(app.library.save(id, str_field(&b, "name"), &b["data"], overwrite).map_err(conflict)?))
        }
        (&Method::POST, "/api/export") => {
            // Word/RTF/Markdown/text are produced in the browser; only PDF needs the server.
            let b = read_json(&headers, body).await?;
            if str_field(&b, "format") != "pdf" {
                return Err(HttpError::new(StatusCode::BAD_REQUEST, "Only PDF is exported by the server."));
            }
            let data = pdf::html_to_pdf(str_field(&b, "html")).await.map_err(server_err)?;
            let mut res = Response::new(Body::from(data));
            let h = res.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=\"document.pdf\""));
            Ok(res)
        }
        (&Method::GET, "/api/access") => ok(json!({
            "isLocal": auth::is_local(&peer, &host),
            "passwordSet": auth::password_set(),
            "urls": auth::lan_addresses().iter().map(|ip| format!("http://{ip}:{}", app.port)).collect::<Vec<_>>(),
        })),
        (&Method::POST, "/api/access/password") => {
            // Only someone sitting at this PC may set the network password.
            if !auth::is_local(&peer, &host) {
                return Err(HttpError::new(StatusCode::FORBIDDEN, "The password can only be changed on the PC running Assist Writer."));
            }
            app.auth.set_password(str_field(&read_json(&headers, body).await?, "password")).map_err(bad)?;
            ok(json!({ "ok": true }))
        }
        _ => {
            // /api/library/<id> and /api/library/<id>/rename
            if let Some(rest) = path.strip_prefix("/api/library/") {
                let (raw_id, rename) = match rest.strip_suffix("/rename") {
                    Some(id) => (id, true),
                    None => (rest, false),
                };
                let id = percent_encoding::percent_decode_str(raw_id).decode_utf8_lossy().to_string();
                return match (&method, rename) {
                    (&Method::POST, true) => {
                        let b = read_json(&headers, body).await?;
                        ok(json!(app.library.rename(&id, str_field(&b, "name")).map_err(conflict)?))
                    }
                    (&Method::GET, false) => ok(app.library.load(&id).map_err(|_| HttpError::new(StatusCode::NOT_FOUND, "Document not found."))?),
                    (&Method::DELETE, false) => {
                        app.library.delete(&id).map_err(bad)?;
                        ok(json!({ "ok": true }))
                    }
                    _ => Err(HttpError::new(StatusCode::NOT_FOUND, "Not found.")),
                };
            }
            Err(HttpError::new(StatusCode::NOT_FOUND, "Not found."))
        }
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

async fn serve_static(app: &App, uri_path: &str) -> ApiResult {
    let decoded = percent_encoding::percent_decode_str(uri_path).decode_utf8_lossy().to_string();
    let mut rel = decoded.trim_start_matches('/').to_string();
    // Single-page app: anything without a file extension is the editor page.
    if rel.is_empty() || Path::new(&rel).extension().is_none() {
        rel = "index.html".into();
    }
    let rel_path = Path::new(&rel);
    if rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(HttpError::new(StatusCode::NOT_FOUND, "Not found."));
    }
    let file = app.ui_dir.join(rel_path);
    let data = tokio::fs::read(&file).await.map_err(|_| HttpError::new(StatusCode::NOT_FOUND, "Not found."))?;
    let mut res = Response::new(Body::from(data));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&file)));
    // Built assets have content hashes in their names, so they can be cached forever.
    let cache = if rel.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    Ok(res)
}

async fn handle(State(app): State<Arc<App>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let host = header_str(&parts.headers, header::HOST).to_string();
    let result: ApiResult = async {
        if !auth::allowed_host(&host) {
            return Err(HttpError::new(StatusCode::FORBIDDEN, "Unknown host."));
        }
        // Other websites open in the same browser must not be able to call the API.
        if parts.method != Method::GET && parts.method != Method::HEAD {
            if let Some(origin) = parts.headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
                let origin_host = origin.split("://").nth(1).unwrap_or_default();
                if !origin_host.eq_ignore_ascii_case(&host) {
                    return Err(HttpError::new(StatusCode::FORBIDDEN, "Cross-site request refused."));
                }
            }
        }
        let path = parts.uri.path().to_string();
        if path.starts_with("/api/") {
            api(app.clone(), peer, parts.method.clone(), &path, parts.uri.query().unwrap_or_default(), parts.headers.clone(), body).await
        } else if parts.method == Method::GET || parts.method == Method::HEAD {
            serve_static(&app, &path).await
        } else {
            Err(HttpError::new(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed."))
        }
    }
    .await;
    with_headers(match result {
        Ok(res) => res,
        Err(HttpError(status, message)) => {
            if status == StatusCode::INTERNAL_SERVER_ERROR {
                eprintln!("error: {message}");
            }
            json_response(status, &json!({ "error": message }))
        }
    })
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

/// The built UI: --ui, ASSIST_WRITER_UI, a `ui` folder next to the program, or out/renderer.
fn find_ui_dir() -> PathBuf {
    let exe_ui = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("ui")));
    [arg("--ui").map(PathBuf::from), std::env::var_os("ASSIST_WRITER_UI").map(PathBuf::from), exe_ui, Some(PathBuf::from("out/renderer"))]
        .into_iter()
        .flatten()
        .find(|d| d.join("index.html").is_file())
        .unwrap_or_else(|| PathBuf::from("out/renderer"))
}

#[tokio::main]
async fn main() {
    let port: u16 = arg("--port").or_else(|| std::env::var("PORT").ok()).and_then(|p| p.parse().ok()).unwrap_or(5178);
    let ui_dir = find_ui_dir();
    if !ui_dir.join("index.html").is_file() {
        eprintln!("\nCan't find the Assist Writer UI. Build it with `npm run build:ui`, or pass --ui <folder>.");
        std::process::exit(1);
    }
    let (settings_changed, _) = tokio::sync::broadcast::channel(16);
    {
        let tx = settings_changed.clone();
        settings::watch(move || {
            let _ = tx.send(());
        });
    }
    let app = Arc::new(App { ollama: Ollama::default(), library: Library::default(), auth: Auth::default(), port, ui_dir, settings_changed });
    let router = Router::new().fallback(handle).with_state(app.clone());

    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("\nPort {port} is already in use. Is Assist Writer already running?\nOpen http://localhost:{port} or start with --port <another number>.");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    println!("\n  Assist Writer is running.\n");
    println!("  On this PC:      http://localhost:{port}");
    for ip in auth::lan_addresses() {
        println!("  On your network: http://{ip}:{port}");
    }
    println!("\n  Documents folder: {}", paths::library_dir().display());
    if !auth::password_set() {
        println!("\n  Other devices need a password. Set one in Settings (gear icon) on this PC.");
    }
    println!("\n  Keep this window open while using Assist Writer. Close it to stop the server.\n");

    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.expect("server");
}
