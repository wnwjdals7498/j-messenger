use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::Mutex,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use keyring::Entry;
use reqwest::{header, multipart, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use url::Url;

const KEYRING_SERVICE: &str = "j-messenger.native-session";
const MAX_TRANSFER_BYTES: usize = 5_000_000;

#[derive(Default)]
struct NativeState {
    server_origin: Mutex<Option<String>>,
    sockets: Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
    opening_sockets: Mutex<HashSet<String>>,
    cancelled_sockets: Mutex<HashSet<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<NativeBody>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum NativeBody {
    Json { text: String },
    File {
        filename: String,
        content_type: String,
        bytes: Vec<u8>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSessionEnvelope {
    data: NativeSessionData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSessionData {
    user: Value,
    credential: String,
    expires_at: String,
}

fn keyring_entry(origin: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, origin).map_err(|_| "credential_store".to_string())
}

fn active_origin(state: &NativeState) -> Result<String, String> {
    state
        .server_origin
        .lock()
        .map_err(|_| "unavailable".to_string())?
        .clone()
        .ok_or_else(|| "server_not_configured".to_string())
}

fn validate_server_origin(value: &str, allow_insecure_http: bool) -> Result<String, String> {
    let parsed = Url::parse(value).map_err(|_| "invalid_server_url".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.scheme() == "http" && !allow_insecure_http)
    {
        return Err("invalid_server_url".to_string());
    }
    Ok(parsed.origin().ascii_serialization())
}

fn validate_target(origin: &str, raw: &str, websocket: bool) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "invalid_target".to_string())?;
    let mut expected = Url::parse(origin).map_err(|_| "invalid_server_url".to_string())?;
    if websocket {
        expected
            .set_scheme(if expected.scheme() == "https" { "wss" } else { "ws" })
            .map_err(|_| "invalid_target".to_string())?;
        if url.scheme() != "ws" && url.scheme() != "wss" {
            return Err("invalid_target".to_string());
        }
    }
    if url.origin() != expected.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/api/v1/events" && websocket
        || (url.path() != "/api/v1" && !url.path().starts_with("/api/v1/"))
        || url.query_pairs().any(|(key, _)| {
            matches!(key.to_ascii_lowercase().as_str(), "token" | "access_token" | "authorization")
        })
    {
        return Err("invalid_target".to_string());
    }
    if !websocket && url.scheme() != expected.scheme() {
        return Err("invalid_target".to_string());
    }
    Ok(url)
}

fn error_response(status: StatusCode, code: &str) -> NativeResponse {
    let payload = json!({
        "error": {
            "code": code,
            "message": "요청을 처리하지 못했습니다.",
            "requestId": "00000000-0000-4000-8000-000000000000"
        }
    });
    NativeResponse {
        status: status.as_u16(),
        headers: HashMap::from([("content-type".to_string(), "application/json".to_string())]),
        body: serde_json::to_vec(&payload).unwrap_or_default(),
    }
}

fn auth_headers(origin: &str) -> Result<header::HeaderMap, String> {
    let mut headers = header::HeaderMap::new();
    match keyring_entry(origin)?.get_password() {
        Ok(token) => {
            if token.len() != 43
                || !token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err("credential_store".to_string());
            }
            let value = header::HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| "credential_store".to_string())?;
            headers.insert(header::AUTHORIZATION, value);
        }
        Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("credential_store".to_string()),
    }
    Ok(headers)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "network".to_string())
}

fn sanitize_session_error(
    status: StatusCode,
    bytes: &[u8],
    request_id: Option<&str>,
) -> NativeResponse {
    let parsed = serde_json::from_slice::<Value>(bytes).ok();
    let error = parsed.as_ref().and_then(|value| value.get("error"));
    let code = error
        .and_then(|value| value.get("code")?.as_str())
        .filter(|code| {
            matches!(
                *code,
                "bad_request" | "unauthorized" | "forbidden" | "conflict" | "unavailable"
            )
        })
        .unwrap_or(if status == StatusCode::UNAUTHORIZED {
            "unauthorized"
        } else {
            "internal"
        });
    let message = error
        .and_then(|value| value.get("message")?.as_str())
        .unwrap_or("요청을 처리하지 못했습니다.");
    let body_request_id = error
        .and_then(|value| value.get("requestId")?.as_str())
        .or(request_id)
        .unwrap_or("00000000-0000-4000-8000-000000000000");
    let mut headers = HashMap::from([(
        "content-type".to_string(),
        "application/json".to_string(),
    )]);
    if let Some(request_id) = request_id {
        headers.insert("x-request-id".to_string(), request_id.to_string());
    }
    NativeResponse {
        status: status.as_u16(),
        headers,
        body: serde_json::to_vec(&json!({
            "error": { "code": code, "message": message, "requestId": body_request_id }
        }))
        .unwrap_or_default(),
    }
}

async fn issue_native_session(
    origin: &str,
    body: &str,
) -> Result<NativeResponse, String> {
    let parsed: Value = serde_json::from_str(body).map_err(|_| "bad_request".to_string())?;
    let request = json!({
        "serverId": parsed.get("serverId").and_then(Value::as_str).ok_or("bad_request")?,
        "username": parsed.get("username").and_then(Value::as_str).ok_or("bad_request")?,
        "password": parsed.get("password").and_then(Value::as_str).ok_or("bad_request")?,
    });
    let client = http_client()?;
    let response = client
        .post(format!("{origin}/api/v1/native/session"))
        .json(&request)
        .send()
        .await
        .map_err(|_| "network".to_string())?;
    let status = response.status();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = response.bytes().await.map_err(|_| "network".to_string())?;
    if !status.is_success() {
        return Ok(sanitize_session_error(status, &bytes, request_id.as_deref()));
    }
    let envelope: NativeSessionEnvelope = serde_json::from_slice(&bytes)
        .map_err(|_| "invalid_response".to_string())?;
    if envelope.data.credential.len() != 43
        || !envelope.data.credential.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || envelope.data.expires_at.is_empty()
    {
        return Err("invalid_response".to_string());
    }
    if keyring_entry(origin)?.set_password(&envelope.data.credential).is_err() {
        let _ = client
            .delete(format!("{origin}/api/v1/session"))
            .bearer_auth(&envelope.data.credential)
            .send()
            .await;
        return Err("credential_store".to_string());
    }
    let payload = json!({ "data": envelope.data.user });
    let mut headers = HashMap::from([(
        "content-type".to_string(),
        "application/json".to_string(),
    )]);
    if let Some(request_id) = request_id {
        headers.insert("x-request-id".to_string(), request_id);
    }
    Ok(NativeResponse {
        status: StatusCode::OK.as_u16(),
        headers,
        body: serde_json::to_vec(&payload).unwrap_or_default(),
    })
}

async fn delete_native_session(origin: &str) -> Result<NativeResponse, String> {
    let token = match keyring_entry(origin)?.get_password() {
        Ok(token) => Some(token),
        Err(keyring::Error::NoEntry) => None,
        Err(_) => return Err("credential_store".to_string()),
    };
    let mut remote_failed = false;
    if let Some(token) = token {
        let client = http_client()?;
        let remote = client
            .delete(format!("{origin}/api/v1/native/session"))
            .bearer_auth(token)
            .send()
            .await;
        remote_failed = remote.map_or(true, |response| {
            !response.status().is_success() && response.status() != StatusCode::UNAUTHORIZED
        });
    }
    keyring_entry(origin)?
        .delete_credential()
        .or_else(|error| if matches!(error, keyring::Error::NoEntry) { Ok(()) } else { Err(error) })
        .map_err(|_| "credential_store".to_string())?;
    if remote_failed {
        return Ok(error_response(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    }
    Ok(NativeResponse {
        status: StatusCode::NO_CONTENT.as_u16(),
        headers: HashMap::new(),
        body: Vec::new(),
    })
}

#[tauri::command]
fn configure_server(
    state: State<'_, NativeState>,
    origin: String,
    allow_insecure_http: bool,
) -> Result<String, String> {
    let origin = validate_server_origin(&origin, allow_insecure_http)?;
    *state.server_origin.lock().map_err(|_| "unavailable".to_string())? = Some(origin.clone());
    Ok(origin)
}

#[tauri::command]
async fn native_fetch(state: State<'_, NativeState>, request: NativeRequest) -> NativeResponse {
    let origin = match active_origin(&state) {
        Ok(origin) => origin,
        Err(code) => return error_response(StatusCode::BAD_REQUEST, &code),
    };
    if request.headers.keys().any(|key| {
        matches!(key.to_ascii_lowercase().as_str(), "cookie" | "authorization" | "proxy-authorization")
    }) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let url = match validate_target(&origin, &request.url, false) {
        Ok(url) => url,
        Err(code) => return error_response(StatusCode::BAD_REQUEST, &code),
    };
    if url.path() == "/api/v1/session" && request.method.eq_ignore_ascii_case("POST") {
        let Some(NativeBody::Json { text }) = request.body else {
            return error_response(StatusCode::BAD_REQUEST, "bad_request");
        };
        return match issue_native_session(&origin, &text).await {
            Ok(response) => response,
            Err(code) => error_response(StatusCode::BAD_GATEWAY, &code),
        };
    }
    if url.path() == "/api/v1/session" && request.method.eq_ignore_ascii_case("DELETE") {
        return match delete_native_session(&origin).await {
            Ok(response) => response,
            Err(code) => error_response(StatusCode::BAD_GATEWAY, &code),
        };
    }
    let method = match Method::from_bytes(request.method.as_bytes()) {
        Ok(method) => method,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "bad_request"),
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "network"),
    };
    let mut call = client.request(method, url).headers(match auth_headers(&origin) {
        Ok(headers) => headers,
        Err(code) => return error_response(StatusCode::UNAUTHORIZED, &code),
    });
    for (name, value) in request.headers {
        if let (Ok(name), Ok(value)) = (
            header::HeaderName::from_bytes(name.as_bytes()),
            header::HeaderValue::from_str(&value),
        ) {
            if name != header::AUTHORIZATION && name != header::COOKIE {
                call = call.header(name, value);
            }
        }
    }
    call = match request.body {
        Some(NativeBody::Json { text }) => call.body(text),
        Some(NativeBody::File { filename, content_type, bytes }) => {
            if bytes.len() > MAX_TRANSFER_BYTES {
                return error_response(StatusCode::PAYLOAD_TOO_LARGE, "too_large");
            }
            let part = match multipart::Part::bytes(bytes)
                .file_name(filename)
                .mime_str(&content_type)
            {
                Ok(part) => part,
                Err(_) => return error_response(StatusCode::BAD_REQUEST, "bad_request"),
            };
            call.multipart(multipart::Form::new().part("file", part))
        }
        None => call,
    };
    let response = match call.send().await {
        Ok(response) => response,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "network"),
    };
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        if let Ok(entry) = keyring_entry(&origin) {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(_) => return error_response(StatusCode::BAD_GATEWAY, "credential_store"),
            }
        }
    }
    let mut headers = HashMap::new();
    for name in ["content-type", "x-request-id", "content-disposition"] {
        if let Some(value) = response.headers().get(name).and_then(|value| value.to_str().ok()) {
            headers.insert(name.to_string(), value.to_string());
        }
    }
    let body = match response.bytes().await {
        Ok(body) => body.to_vec(),
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "network"),
    };
    NativeResponse { status: status.as_u16(), headers, body }
}

#[tauri::command]
async fn native_ws_open(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
    socket_id: String,
    url: String,
) -> Result<(), String> {
    if !valid_socket_id(&socket_id) {
        return Err("bad_request".to_string());
    }
    let origin = active_origin(&state)?;
    let url = validate_target(&origin, &url, true)?;
    let token = keyring_entry(&origin)?.get_password().map_err(|_| "unauthorized".to_string())?;
    if token.len() != 43 || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("unauthorized".to_string());
    }
    let mut request = url.as_str().into_client_request().map_err(|_| "invalid_target".to_string())?;
    request.headers_mut().insert(
        header::AUTHORIZATION,
        header::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "unauthorized".to_string())?,
    );
    state
        .opening_sockets
        .lock()
        .map_err(|_| "unavailable".to_string())?
        .insert(socket_id.clone());
    let (stream, _) = match connect_async(request).await {
        Ok(connection) => connection,
        Err(_) => {
            if let Ok(mut opening) = state.opening_sockets.lock() {
                opening.remove(&socket_id);
            }
            return Err("network".to_string());
        }
    };
    let (mut sink, mut source) = stream.split();
    let (send, mut receive) = mpsc::unbounded_channel::<Message>();
    let mut opening = state
        .opening_sockets
        .lock()
        .map_err(|_| "unavailable".to_string())?;
    opening.remove(&socket_id);
    let cancelled = state
        .cancelled_sockets
        .lock()
        .map_err(|_| "unavailable".to_string())?
        .remove(&socket_id);
    if cancelled {
        return Err("network".to_string());
    }
    state
        .sockets
        .lock()
        .map_err(|_| "unavailable".to_string())?
        .insert(socket_id.clone(), send);
    drop(opening);
    let message_event = format!("native-ws-{socket_id}-message");
    let close_event = format!("native-ws-{socket_id}-close");
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                outgoing = receive.recv() => match outgoing {
                    Some(message) => if sink.send(message).await.is_err() { break; },
                    None => break,
                },
                incoming = source.next() => match incoming {
                    Some(Ok(Message::Text(text))) => { let _ = app.emit(&message_event, text.to_string()); },
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
        if let Ok(mut sockets) = app.state::<NativeState>().sockets.lock() {
            sockets.remove(&socket_id);
        }
        let _ = app.emit(&close_event, ());
    });
    Ok(())
}

#[tauri::command]
fn native_ws_send(state: State<'_, NativeState>, socket_id: String, text: String) -> Result<(), String> {
    if !valid_socket_id(&socket_id) {
        return Err("bad_request".to_string());
    }
    let sockets = state.sockets.lock().map_err(|_| "unavailable".to_string())?;
    let sender = sockets.get(&socket_id).ok_or_else(|| "network".to_string())?;
    sender.send(Message::Text(text.into())).map_err(|_| "network".to_string())
}

#[tauri::command]
fn native_ws_close(state: State<'_, NativeState>, socket_id: String) {
    if !valid_socket_id(&socket_id) {
        return;
    }
    if let Ok(opening) = state.opening_sockets.lock() {
        if opening.contains(&socket_id) {
            if let Ok(mut cancelled) = state.cancelled_sockets.lock() {
                cancelled.insert(socket_id);
            }
            return;
        }
    }
    if let Ok(mut sockets) = state.sockets.lock() {
        sockets.remove(&socket_id);
    }
}

fn valid_socket_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[tauri::command]
async fn native_pick_file() -> Result<Option<PickedFile>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .add_filter("허용된 첨부", &["png", "jpg", "jpeg", "webp", "pdf", "txt", "csv", "docx", "xlsx", "zip"])
        .pick_file()
        .await;
    let Some(file) = picked else { return Ok(None) };
    if file.path().metadata().map_err(|_| "file_read".to_string())?.len() > MAX_TRANSFER_BYTES as u64 {
        return Err("too_large".to_string());
    }
    let bytes = file.read().await;
    if bytes.len() > MAX_TRANSFER_BYTES {
        return Err("too_large".to_string());
    }
    Ok(Some(PickedFile { filename: file.file_name(), bytes }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    filename: String,
    bytes: Vec<u8>,
}

#[tauri::command]
async fn native_save_file(filename: String, bytes: Vec<u8>) -> Result<bool, String> {
    if bytes.len() > MAX_TRANSFER_BYTES {
        return Err("too_large".to_string());
    }
    let safe_name = filename
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .take(120)
        .collect::<String>();
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(if safe_name.is_empty() { "attachment" } else { &safe_name })
        .save_file()
        .await;
    let Some(file) = file else { return Ok(false) };
    tokio::fs::write(file.path(), bytes).await.map_err(|_| "file_write".to_string())?;
    Ok(true)
}

pub fn run() {
    tauri::Builder::default()
        .manage(NativeState::default())
        .invoke_handler(tauri::generate_handler![
            configure_server,
            native_fetch,
            native_ws_open,
            native_ws_send,
            native_ws_close,
            native_pick_file,
            native_save_file
        ])
        .run(tauri::generate_context!())
        .expect("Tauri desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use super::{valid_socket_id, validate_server_origin, validate_target};

    #[test]
    fn server_origins_must_have_no_path_credentials_or_query() {
        assert_eq!(validate_server_origin("https://chat.example", false).unwrap(), "https://chat.example");
        assert_eq!(validate_server_origin("http://127.0.0.1:3000", true).unwrap(), "http://127.0.0.1:3000");
        for bad in [
            "ftp://chat.example",
            "http://chat.example",
            "https://user:pass@chat.example",
            "https://chat.example/path",
            "https://chat.example/?token=secret",
            "https://chat.example/#fragment",
        ] {
            assert!(validate_server_origin(bad, false).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn native_requests_must_stay_on_configured_api_origin() {
        assert!(validate_target("https://chat.example", "https://chat.example/api/v1/me", false).is_ok());
        for bad in [
            "https://other.example/api/v1/me",
            "http://chat.example/api/v1/me",
            "https://chat.example/outside",
            "https://chat.example/api/v1/me?access_token=secret",
        ] {
            assert!(validate_target("https://chat.example", bad, false).is_err(), "accepted {bad}");
        }
        assert!(validate_target("https://chat.example", "wss://chat.example/api/v1/events", true).is_ok());
        assert!(validate_target("https://chat.example", "wss://other.example/api/v1/events", true).is_err());
    }

    #[test]
    fn socket_event_names_require_uuid_identifiers() {
        assert!(valid_socket_id("00000000-0000-4000-8000-000000000001"));
        assert!(!valid_socket_id("native-ws-attack"));
    }
}
