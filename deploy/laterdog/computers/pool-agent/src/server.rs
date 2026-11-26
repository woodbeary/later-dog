use crate::engines::{self, Frame, OpenError, Shared};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::TryRecvError;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::Role;
use tungstenite::{Error as WsError, Message, WebSocket};

const HEAD_MAX: usize = 16 * 1024;
const BODY_MAX: usize = 1024 * 1024;
const PING_EVERY: Duration = Duration::from_secs(15);

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        if buffer.len() > HEAD_MAX {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let path = first.next()?.split('?').next()?.to_string();
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    if length > BODY_MAX {
        return None;
    }
    let mut body = buffer[end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Some(Request { method, path, headers, body })
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
}

fn refusal(code: &str, message: &str) -> Value {
    json!({ "error": { "code": code, "message": message } })
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value.as_array()?.iter().map(|item| item.as_str().map(str::to_string)).collect()
}

fn pairs(value: Option<&Value>) -> Option<Vec<(String, String)>> {
    match value {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::Object(map)) => map.iter().map(|(name, item)| item.as_str().map(|text| (name.clone(), text.to_string()))).collect(),
        Some(_) => None,
    }
}

fn open(shared: &Shared, request: &Request) -> (u16, Value) {
    let Ok(body) = serde_json::from_slice::<Value>(&request.body) else { return (400, refusal("invalid_body", "The body must be JSON.")) };
    let Some(chat) = body.get("chat").and_then(Value::as_str) else { return (400, refusal("invalid_chat", "chat is required.")) };
    let Some(command) = body.get("command").and_then(strings) else { return (400, refusal("invalid_command", "command must be a list of strings.")) };
    let Some(env) = pairs(body.get("env")) else { return (400, refusal("invalid_env", "env must map names to strings.")) };
    match engines::open(shared, chat, &command, &env) {
        Ok((status, engine)) => (status, json!({ "engine": engine })),
        Err(OpenError::Invalid(message)) => (400, refusal("invalid_engine", &message)),
        Err(OpenError::Full(message)) => (503, refusal("host_full", &message)),
        Err(OpenError::Failed(message)) => (500, refusal("engine_failed", &message)),
    }
}

fn chat_path<'a>(path: &'a str, suffix: &str) -> Option<&'a str> {
    let chat = path.strip_prefix("/engines/")?.strip_suffix(suffix)?;
    (!chat.contains('/') && engines::valid_chat(chat)).then_some(chat)
}

fn serve_one(shared: Shared, mut stream: TcpStream) {
    let Some(request) = read_request(&mut stream) else { return };
    let upgrade = request.headers.get("upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    if let (Some(chat), true) = (chat_path(&request.path, "/stream"), upgrade) {
        return stream_engine(shared, stream, chat.to_string(), &request);
    }
    let (status, body) = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/status") => (200, shared.lock().unwrap().status()),
        ("POST", "/engines") => open(&shared, &request),
        ("DELETE", path) => match chat_path(path, "") {
            Some(chat) if engines::close(&shared, chat) => (200, json!({ "closed": chat })),
            _ => (404, refusal("not_warm", "No warm engine for that chat.")),
        },
        _ => (404, refusal("not_found", "No such route.")),
    };
    respond(&mut stream, status, &body);
}

fn text(socket: &mut WebSocket<TcpStream>, value: Value) -> bool {
    socket.send(Message::Text(value.to_string())).is_ok()
}

fn binary(socket: &mut WebSocket<TcpStream>, channel: u8, bytes: &[u8]) -> bool {
    let mut frame = Vec::with_capacity(bytes.len() + 1);
    frame.push(channel);
    frame.extend_from_slice(bytes);
    socket.send(Message::Binary(frame)).is_ok()
}

fn stream_engine(shared: Shared, mut stream: TcpStream, chat: String, request: &Request) {
    let Some(key) = request.headers.get("sec-websocket-key") else {
        return respond(&mut stream, 400, &refusal("invalid_upgrade", "A WebSocket key is required."));
    };
    let Some(attached) = engines::attach(&shared, &chat) else {
        return respond(&mut stream, 404, &refusal("not_warm", "No warm engine for that chat; open it first."));
    };
    let accept = derive_accept_key(key.as_bytes());
    if write!(stream, "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n").is_err() {
        return engines::detach(&shared, &chat, attached.id);
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(10)));
    let _ = stream.set_nodelay(true);
    let mut socket = WebSocket::from_raw_socket(stream, Role::Server, None);
    let mut alive = text(&mut socket, json!({ "channel": "attached", "chat": chat, "buffered": attached.buffered.len() }));
    if alive && !attached.buffered.is_empty() {
        alive = binary(&mut socket, 1, &attached.buffered);
    }
    let mut pinged = Instant::now();
    while alive {
        loop {
            match attached.frames.try_recv() {
                Ok(Frame::Out(channel, bytes)) => alive = binary(&mut socket, channel, &bytes),
                Ok(Frame::Exit(code)) => {
                    let _ = text(&mut socket, json!({ "channel": "exit", "code": code }));
                    alive = false;
                }
                Ok(Frame::Closed(reason)) => {
                    let _ = text(&mut socket, json!({ "channel": "closed", "reason": reason }));
                    alive = false;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => alive = false,
            }
            if !alive {
                break;
            }
        }
        if !alive {
            break;
        }
        if pinged.elapsed() >= PING_EVERY {
            alive = socket.send(Message::Ping(Vec::new())).is_ok();
            pinged = Instant::now();
        }
        match socket.read() {
            Ok(Message::Binary(bytes)) => {
                let mut stdin = attached.stdin.lock().unwrap();
                let written = stdin.as_mut().is_some_and(|pipe| pipe.write_all(&bytes).and_then(|_| pipe.flush()).is_ok());
                drop(stdin);
                if !written {
                    let _ = text(&mut socket, json!({ "channel": "error", "message": "The engine stopped reading its input." }));
                }
            }
            Ok(Message::Text(frame)) => {
                if serde_json::from_str::<Value>(&frame).ok().and_then(|value| value.get("channel").and_then(Value::as_str).map(str::to_string)).as_deref() == Some("detach") {
                    alive = false;
                }
            }
            Ok(Message::Close(_)) => alive = false,
            Ok(_) => {}
            Err(WsError::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => alive = false,
        }
    }
    let _ = socket.close(None);
    let _ = socket.flush();
    engines::detach(&shared, &chat, attached.id);
}

pub fn listen(shared: Shared, port: u16) {
    let listener = TcpListener::bind(("0.0.0.0", port)).unwrap_or_else(|error| {
        eprintln!("laterdog pool: could not listen on {port}: {error}");
        std::process::exit(1)
    });
    eprintln!("laterdog pool: listening on {port}");
    for stream in listener.incoming().flatten() {
        let shared = shared.clone();
        thread::spawn(move || serve_one(shared, stream));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_only_well_formed_chat_paths() {
        assert_eq!(chat_path("/engines/dog_1.t2/stream", "/stream"), Some("dog_1.t2"));
        assert_eq!(chat_path("/engines/a/b/stream", "/stream"), None);
        assert_eq!(chat_path("/engines/dog_1", ""), Some("dog_1"));
        assert_eq!(chat_path("/status", ""), None);
    }

    #[test]
    fn reads_engine_env_as_string_pairs_only() {
        assert_eq!(pairs(Some(&json!({ "A": "1" }))), Some(vec![("A".into(), "1".into())]));
        assert_eq!(pairs(None), Some(vec![]));
        assert_eq!(pairs(Some(&json!({ "A": 1 }))), None);
    }
}
