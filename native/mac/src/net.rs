use std::io::Read;
use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use std::time::Duration;

use laterdog_core::events::{retry_delay, Decoder, Frame, STALE_MS};
use laterdog_core::outbox::{Failure, Item};
use laterdog_core::wire::{parse, send_path, BotsPage, SendBody, SendReceipt};
use ureq::http::Response;
use ureq::{Agent, Body};

const PAGE_PATH: &str = "/api/bots?messages=30";
const EVENTS_PATH: &str = "/api/events";
const WAKE_HEADER: &str = "x-laterdog-home";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const RETRY_AFTER_CAP_MS: u64 = 15_000;

pub enum Inbound {
    Page(BotsPage),
    PageFailed,
    Frame(Frame),
    StreamLost,
    SendDone { send_id: String, result: Result<SendReceipt, Failure> },
}

pub type Post = std::sync::Arc<dyn Fn(Inbound) + Send + Sync>;

#[derive(Clone)]
pub struct Home {
    base: String,
    token: Option<String>,
    requests: Agent,
    stream: Agent,
}

pub struct Lines {
    pub reload: Sender<()>,
    pub send: Sender<Item>,
}

impl Home {
    pub fn new(base: &str, token: Option<String>) -> Self {
        let requests = Agent::config_builder().http_status_as_error(false).timeout_global(Some(REQUEST_TIMEOUT)).build().into();
        let stream = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(15)))
            .timeout_recv_body(Some(Duration::from_millis(STALE_MS)))
            .build()
            .into();
        Home { base: base.trim_end_matches('/').to_owned(), token: token.filter(|token| !token.is_empty()), requests, stream }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn bearer(&self) -> Option<String> {
        self.token.as_ref().map(|token| format!("Bearer {token}"))
    }

    fn get(&self, agent: &Agent, path: &str) -> Result<Response<Body>, ureq::Error> {
        let mut request = agent.get(self.url(path));
        if let Some(bearer) = self.bearer() {
            request = request.header("authorization", bearer);
        }
        request.call()
    }

    fn page(&self) -> Option<BotsPage> {
        let mut response = self.get(&self.requests, PAGE_PATH).ok()?;
        if !response.status().is_success() {
            return None;
        }
        parse(&response.body_mut().read_to_string().ok()?)
    }

    pub fn deliver(&self, item: &Item) -> Result<SendReceipt, Failure> {
        let mut request = self.requests.post(self.url(&send_path(item))).header("content-type", "application/json");
        if let Some(bearer) = self.bearer() {
            request = request.header("authorization", bearer);
        }
        let mut response = request.send(SendBody::for_item(item).json()).map_err(|error| failure_of(&error))?;
        let status = response.status().as_u16();
        let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
        let wake = header(WAKE_HEADER);
        let retry_header = header("retry-after");
        let body = response.body_mut().read_to_string().unwrap_or_default();
        if (200..300).contains(&status) {
            return Ok(parse(&body).unwrap_or_default());
        }
        let retry_after_ms = retry_after(retry_header.as_deref(), &body);
        if status == 503 && matches!(wake.as_deref(), Some("waking" | "busy" | "asleep")) {
            return Err(Failure::Waking { retry_after_ms });
        }
        Err(Failure::Status { code: status, retry_after_ms })
    }

    pub fn start(self, post: Post) -> Lines {
        let (reload, reloads) = std::sync::mpsc::channel::<()>();
        let (send, sends) = std::sync::mpsc::channel::<Item>();
        let loader = self.clone();
        let loader_post = post.clone();
        thread::Builder::new().name("page".into()).spawn(move || loader.load_pages(&reloads, &loader_post)).ok();
        let streamer = self.clone();
        let stream_post = post.clone();
        let stream_reload = reload.clone();
        thread::Builder::new().name("events".into()).spawn(move || streamer.hold_stream(&stream_reload, &stream_post)).ok();
        thread::Builder::new().name("outbox".into()).spawn(move || self.drain(&sends, &post)).ok();
        Lines { reload, send }
    }

    fn load_pages(&self, reloads: &Receiver<()>, post: &Post) {
        while reloads.recv().is_ok() {
            let mut attempt = 0;
            loop {
                while reloads.try_recv().is_ok() {}
                if let Some(page) = self.page() {
                    post(Inbound::Page(page));
                    break;
                }
                post(Inbound::PageFailed);
                thread::sleep(Duration::from_millis(retry_delay(attempt)));
                attempt += 1;
            }
        }
    }

    fn hold_stream(&self, reload: &Sender<()>, post: &Post) {
        let mut decoder = Decoder::new();
        let mut attempt = 0;
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            let path = match decoder.last_event_id() {
                Some(cursor) => format!("{EVENTS_PATH}?since={}", query_escape(cursor)),
                None => EVENTS_PATH.to_owned(),
            };
            if let Ok(response) = self.get(&self.stream, &path) {
                if response.status().is_success() {
                    decoder.reset_connection();
                    let mut reader = response.into_body().into_reader();
                    while let Ok(read) = reader.read(&mut buffer) {
                        if read == 0 {
                            break;
                        }
                        for frame in decoder.feed(&buffer[..read]) {
                            match frame {
                                Frame::Ping => attempt = 0,
                                Frame::Hello { resumed: false, .. } => {
                                    reload.send(()).ok();
                                    post(Inbound::Frame(frame));
                                }
                                frame => post(Inbound::Frame(frame)),
                            }
                        }
                    }
                }
            }
            post(Inbound::StreamLost);
            thread::sleep(Duration::from_millis(retry_delay(attempt)));
            attempt = attempt.saturating_add(1);
        }
    }

    fn drain(&self, sends: &Receiver<Item>, post: &Post) {
        while let Ok(item) = sends.recv() {
            let result = self.deliver(&item);
            post(Inbound::SendDone { send_id: item.send_id, result });
        }
    }
}

fn failure_of(error: &ureq::Error) -> Failure {
    match error {
        ureq::Error::Timeout(_) => Failure::Timeout,
        ureq::Error::StatusCode(code) => Failure::Status { code: *code, retry_after_ms: None },
        _ => Failure::Network,
    }
}

fn retry_after(header: Option<&str>, body: &str) -> Option<u64> {
    let from_body = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("retryAfter").and_then(serde_json::Value::as_f64));
    let seconds = from_body.filter(|seconds| *seconds > 0.0).or_else(|| header.and_then(|value| value.trim().parse::<f64>().ok()))?;
    (seconds.is_finite() && seconds > 0.0).then(|| ((seconds * 1_000.0) as u64).clamp(1_000, RETRY_AFTER_CAP_MS))
}

fn query_escape(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b':' | b'~' => (byte as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}
