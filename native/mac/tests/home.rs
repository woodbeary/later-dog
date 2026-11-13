use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use laterdog_core::store::{Connection, SendState};
use laterdog_mac::net::{Home, Inbound};
use laterdog_mac::session::Session;

const BOT: &str = "b1";
const THREAD: &str = "t1";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Posts {
    Accept,
    HangUp,
    Waking,
    Forbidden,
}

struct State {
    frames: Vec<(u64, String)>,
    posts: Posts,
    stream_up: bool,
    resume: bool,
    cut: u64,
    page_loads: u32,
    sinces: Vec<Option<String>>,
    received: Vec<(String, u16)>,
}

#[derive(Clone)]
struct FakeHome {
    state: Arc<(Mutex<State>, Condvar)>,
    url: String,
}

impl FakeHome {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a free port");
        let url = format!("http://{}", listener.local_addr().expect("an address"));
        let state = Arc::new((
            Mutex::new(State { frames: Vec::new(), posts: Posts::Accept, stream_up: true, resume: true, cut: 0, page_loads: 0, sinces: Vec::new(), received: Vec::new() }),
            Condvar::new(),
        ));
        let home = FakeHome { state, url };
        let serving = home.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let serving = serving.clone();
                thread::spawn(move || serving.serve(stream));
            }
        });
        home
    }

    fn with<T>(&self, change: impl FnOnce(&mut State) -> T) -> T {
        let (lock, wake) = &*self.state;
        let mut state = lock.lock().expect("state");
        let out = change(&mut state);
        wake.notify_all();
        out
    }

    fn push(&self, frame: serde_json::Value) {
        self.with(|state| {
            let seq = state.frames.len() as u64 + 1;
            state.frames.push((seq, frame.to_string()));
        });
    }

    fn message(&self, id: &str, at: u64, text: &str) {
        self.push(serde_json::json!({ "kind": "message", "threadId": THREAD, "message": { "id": id, "at": at, "role": "bot", "kind": "text", "text": text } }));
    }

    fn serve(&self, mut stream: TcpStream) {
        let Some((method, target, body)) = read_request(&stream) else { return };
        let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
        match (method.as_str(), path) {
            ("GET", "/api/bots") => {
                self.with(|state| state.page_loads += 1);
                let page = serde_json::json!({ "bots": [{ "id": BOT, "threadId": THREAD, "name": "Rex", "unread": false, "hasMore": false,
                    "messages": [{ "id": "m0", "at": 1, "role": "bot", "kind": "text", "text": "hello" }] }] });
                reply(&mut stream, "200 OK", &[], &page.to_string());
            }
            ("GET", "/api/events") => self.stream_events(stream, query),
            ("POST", "/api/bots/b1/messages") => self.take_post(stream, &body),
            _ => reply(&mut stream, "404 Not Found", &[], "{}"),
        }
    }

    fn stream_events(&self, mut stream: TcpStream, query: &str) {
        let since = query.strip_prefix("since=").map(|value| value.replace("%3A", ":"));
        let (up, resume, last, cut) = self.with(|state| {
            state.sinces.push(since.clone());
            (state.stream_up, state.resume, state.frames.len() as u64, state.cut)
        });
        if !up {
            reply(&mut stream, "503 Service Unavailable", &[], "{}");
            return;
        }
        let since_seq = since.as_deref().and_then(|cursor| cursor.strip_prefix("fake:")).and_then(|seq| seq.parse::<u64>().ok());
        let resumed = resume && since_seq.is_some_and(|seq| seq <= last);
        let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
        let hello = format!("data: {}\n\n", serde_json::json!({ "kind": "hello", "cursor": format!("fake:{last}"), "resumed": resumed }));
        if stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(hello.as_bytes())).is_err() {
            return;
        }
        let mut sent = if resumed { since_seq.unwrap_or(last) } else { last };
        let (lock, wake) = &*self.state;
        loop {
            let guard = lock.lock().expect("state");
            let (guard, _) = wake.wait_timeout(guard, Duration::from_millis(50)).expect("state");
            if guard.cut != cut {
                drop(guard);
                stream.write_all(b"id: fake:999\ndata: {\"kind\":\"mess").ok();
                stream.shutdown(Shutdown::Both).ok();
                return;
            }
            let fresh: Vec<(u64, String)> = guard.frames.iter().filter(|(seq, _)| *seq > sent).cloned().collect();
            drop(guard);
            for (seq, frame) in fresh {
                if stream.write_all(format!("id: fake:{seq}\ndata: {frame}\n\n").as_bytes()).is_err() {
                    return;
                }
                sent = seq;
            }
        }
    }

    fn take_post(&self, mut stream: TcpStream, body: &str) {
        let value: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
        let send_id = value["sendId"].as_str().unwrap_or_default().to_owned();
        let text = value["text"].as_str().unwrap_or_default().to_owned();
        let mode = self.with(|state| state.posts);
        let code = match mode {
            Posts::Accept => 200,
            Posts::HangUp => 0,
            Posts::Waking => 503,
            Posts::Forbidden => 403,
        };
        self.with(|state| state.received.push((send_id.clone(), code)));
        match mode {
            Posts::HangUp => {
                stream.shutdown(Shutdown::Both).ok();
            }
            Posts::Waking => reply(&mut stream, "503 Service Unavailable", &[("x-laterdog-home", "waking"), ("retry-after", "1")], "{}"),
            Posts::Forbidden => reply(&mut stream, "403 Forbidden", &[], "{\"error\":\"not allowed\"}"),
            Posts::Accept => {
                let message = serde_json::json!({ "id": format!("home-{send_id}"), "at": 50, "role": "user", "kind": "text", "text": text, "sendId": send_id });
                reply(&mut stream, "200 OK", &[], &serde_json::json!({ "ok": true, "threadId": THREAD, "message": message }).to_string());
                self.push(serde_json::json!({ "kind": "message", "threadId": THREAD, "message": message }));
            }
        }
    }

    fn accepted(&self, send_id: &str) -> usize {
        self.with(|state| state.received.iter().filter(|(id, code)| id == send_id && *code == 200).count())
    }

    fn attempts(&self, send_id: &str) -> Vec<u16> {
        self.with(|state| state.received.iter().filter(|(id, _)| id == send_id).map(|(_, code)| *code).collect())
    }
}

fn read_request(stream: &TcpStream) -> Option<(String, String, String)> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some((method, target, String::from_utf8_lossy(&body).into_owned()))
}

fn reply(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &str) {
    let extra: String = headers.iter().map(|(name, value)| format!("{name}: {value}\r\n")).collect();
    let text = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n{body}", body.len());
    stream.write_all(text.as_bytes()).ok();
    stream.shutdown(Shutdown::Write).ok();
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

struct Driver {
    session: Session,
    inbound: Receiver<Inbound>,
    seen: Vec<Connection>,
}

impl Driver {
    fn connect(home: &FakeHome) -> Self {
        let (tx, inbound) = channel::<Inbound>();
        let tx = Mutex::new(tx);
        let post: laterdog_mac::net::Post = Arc::new(move |message| {
            tx.lock().expect("sender").send(message).ok();
        });
        let mut session = Session::new([5; 16], None);
        session.attach(Home::new(&home.url, None).start(post));
        Driver { session, inbound, seen: Vec::new() }
    }

    fn until(&mut self, wait: Duration, done: impl Fn(&Session) -> bool) -> bool {
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            if let Ok(message) = self.inbound.recv_timeout(Duration::from_millis(20)) {
                self.session.handle(message, now_ms());
            }
            self.session.pump(now_ms());
            let connection = self.session.store.connection();
            if self.seen.last() != Some(&connection) {
                self.seen.push(connection);
            }
            if done(&self.session) {
                return true;
            }
        }
        false
    }

    fn rows(&self) -> Vec<String> {
        self.session.store.thread(THREAD).iter().map(|message| message.id.clone()).collect()
    }
}

fn connected(session: &Session) -> bool {
    session.store.connection() == Connection::Connected && !session.store.dog_ids().is_empty()
}

#[test]
fn a_cut_stream_reconnects_and_replays_what_was_missed() {
    let home = FakeHome::start();
    let mut driver = Driver::connect(&home);
    assert!(driver.until(Duration::from_secs(10), connected), "never connected");
    home.message("m1", 10, "one");
    assert!(driver.until(Duration::from_secs(5), |session| session.store.thread(THREAD).iter().any(|message| message.id == "m1")));

    home.with(|state| {
        state.stream_up = false;
        state.cut += 1;
    });
    assert!(driver.until(Duration::from_secs(5), |session| session.store.connection() == Connection::Reconnecting));
    home.message("m2", 20, "two");
    home.message("m3", 30, "three");
    thread::sleep(Duration::from_millis(600));
    home.with(|state| state.stream_up = true);
    assert!(driver.until(Duration::from_secs(15), |session| session.store.thread(THREAD).iter().any(|message| message.id == "m3")), "missed frames never arrived");
    assert!(driver.until(Duration::from_secs(2), connected));
    assert_eq!(driver.rows(), ["m0", "m1", "m2", "m3"]);
    let sinces = home.with(|state| state.sinces.clone());
    assert!(sinces.iter().any(|since| since.as_deref() == Some("fake:1")), "{sinces:?}");
    let order: Vec<Connection> = driver.seen.iter().copied().filter(|state| *state != Connection::Connecting).collect();
    let flips: Vec<&Connection> = order.windows(2).filter(|pair| pair[0] != pair[1]).map(|pair| &pair[1]).collect();
    assert!(order.first() == Some(&Connection::Connected) && flips.contains(&&Connection::Reconnecting) && order.last() == Some(&Connection::Connected), "{order:?}");

    let loads = home.with(|state| state.page_loads);
    home.with(|state| {
        state.resume = false;
        state.cut += 1;
    });
    assert!(driver.until(Duration::from_secs(15), |_| home.with(|state| state.page_loads) > loads), "a fresh stream did not reload the page");
    assert!(driver.until(Duration::from_secs(5), connected));
}

#[test]
fn a_send_during_an_outage_is_held_with_its_words_and_delivered_once() {
    let home = FakeHome::start();
    let mut driver = Driver::connect(&home);
    assert!(driver.until(Duration::from_secs(10), connected));
    home.with(|state| state.posts = Posts::HangUp);
    let item = driver.session.compose("while you were away", now_ms()).expect("composed");
    assert!(driver.until(Duration::from_secs(5), |session| session.store.send_state(&item.send_id) == Some(SendState::Held)));
    let row = driver.session.store.view().transcript.into_iter().last().expect("a row");
    assert_eq!((row.text.as_str(), row.status), ("while you were away", Some("Sends when your home is up")));
    home.with(|state| state.posts = Posts::Waking);
    assert!(driver.until(Duration::from_secs(8), |_| home.attempts(&item.send_id).contains(&503)), "never retried while waking");
    home.with(|state| state.posts = Posts::Accept);
    assert!(driver.until(Duration::from_secs(10), |session| session.store.send_state(&item.send_id) == Some(SendState::Sent)), "never delivered");
    driver.until(Duration::from_millis(800), |_| false);
    assert_eq!(home.accepted(&item.send_id), 1, "{:?}", home.attempts(&item.send_id));
    let copies = driver.session.store.view().transcript.into_iter().filter(|row| row.text == "while you were away").count();
    assert_eq!(copies, 1);
}

#[test]
fn a_refused_send_keeps_its_words_and_send_again_reuses_its_id() {
    let home = FakeHome::start();
    let mut driver = Driver::connect(&home);
    assert!(driver.until(Duration::from_secs(10), connected));
    home.with(|state| state.posts = Posts::Forbidden);
    let item = driver.session.compose("may I", now_ms()).expect("composed");
    assert!(driver.until(Duration::from_secs(5), |session| session.store.send_state(&item.send_id) == Some(SendState::NotSent)));
    let row = driver.session.store.view().transcript.into_iter().last().expect("a row");
    assert_eq!((row.text.as_str(), row.status, row.send_id.as_deref()), ("may I", Some("Not sent"), Some(item.send_id.as_str())));
    home.with(|state| state.posts = Posts::Accept);
    assert!(driver.session.send_again(&item.send_id));
    assert!(driver.until(Duration::from_secs(5), |session| session.store.send_state(&item.send_id) == Some(SendState::Sent)));
    assert_eq!(home.attempts(&item.send_id), [403, 200]);
}
