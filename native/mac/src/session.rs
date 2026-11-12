use std::path::{Path, PathBuf};

use laterdog_core::events::Frame;
use laterdog_core::outbox::Item;
use laterdog_core::store::{Changes, Connection, Store};

use crate::net::{Inbound, Lines, Request};

pub const OUTBOX_FILE: &str = "outbox.json";

pub fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("LATERDOG_NATIVE_DATA").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")?;
    Some(Path::new(&home).join("Library/Application Support/later.dog Native"))
}

pub struct Session {
    pub store: Store,
    home: Option<Lines>,
    data: Option<PathBuf>,
    saved: Option<String>,
    wake_at: Option<u64>,
}

impl Session {
    pub fn new(seed: [u8; 16], data: Option<PathBuf>) -> Self {
        let mut store = Store::new(seed);
        let saved = data.as_deref().and_then(|dir| std::fs::read_to_string(dir.join(OUTBOX_FILE)).ok());
        if let Some(raw) = &saved {
            store.restore_outbox(raw);
        }
        Session { saved: store.saved_outbox(), store, home: None, data, wake_at: None }
    }

    pub fn attach(&mut self, home: Lines) {
        home.requests.send(Request::Page).ok();
        self.home = Some(home);
    }

    pub fn connected(&self) -> bool {
        self.home.is_some()
    }

    pub fn handle(&mut self, inbound: Inbound, now_ms: u64) -> Changes {
        let changes = match inbound {
            Inbound::Page(page) => self.store.apply_page(page),
            Inbound::PageFailed => Changes::default(),
            Inbound::Frame(frame) => self.store.apply_frame(&frame),
            Inbound::StreamLost => self.store.set_connection(Connection::Reconnecting),
            Inbound::SendDone { send_id, result } => match result {
                Ok(receipt) => self.store.send_succeeded(&send_id, receipt),
                Err(failure) => self.store.send_failed(&send_id, &failure, now_ms),
            },
            Inbound::Older { thread_id, page } => match page {
                Some(page) => self.store.apply_older(&thread_id, page),
                None => {
                    self.store.older_failed(&thread_id);
                    Changes::default()
                }
            },
            Inbound::Read { bot_id, bot } => match bot {
                Some(bot) => self.store.apply_frame(&Frame::Bot { bot }),
                None => {
                    self.store.read_answered(&bot_id);
                    Changes::default()
                }
            },
        };
        self.persist();
        changes
    }

    pub fn compose(&mut self, text: &str, now_ms: u64) -> Option<Item> {
        let item = self.store.compose(text, now_ms)?;
        self.persist();
        Some(item)
    }

    pub fn compose_to(&mut self, bot_id: &str, thread_id: &str, text: &str, now_ms: u64) -> Option<Item> {
        let item = self.store.compose_to(bot_id, thread_id, text, now_ms)?;
        self.persist();
        Some(item)
    }

    pub fn send_again(&mut self, send_id: &str) -> bool {
        let again = self.store.send_again(send_id).is_some();
        self.persist();
        again
    }

    pub fn pump(&mut self, now_ms: u64) -> Option<u64> {
        let due = self.store.due(now_ms);
        if let Some(home) = &self.home {
            for item in due {
                home.send.send(item).ok();
            }
        }
        let at = self.store.next_wake_ms()?;
        if self.wake_at.is_some_and(|scheduled| scheduled <= at) {
            return None;
        }
        self.wake_at = Some(at);
        Some(at)
    }

    pub fn woke(&mut self) {
        self.wake_at = None;
    }

    pub fn ask_older(&mut self) -> bool {
        let (Some(home), Some((thread_id, before))) = (&self.home, self.store.older_request()) else { return false };
        home.requests.send(Request::Older { thread_id, before }).is_ok()
    }

    pub fn ask_read(&mut self, looking: bool) -> bool {
        if !looking || self.home.is_none() {
            return false;
        }
        let Some((bot_id, thread_id)) = self.store.read_request() else { return false };
        self.home.as_ref().is_some_and(|home| home.requests.send(Request::Read { bot_id, thread_id }).is_ok())
    }

    fn persist(&mut self) {
        let now = self.store.saved_outbox();
        if now == self.saved {
            return;
        }
        let Some(dir) = &self.data else { return };
        let file = dir.join(OUTBOX_FILE);
        let written = match &now {
            Some(raw) => std::fs::create_dir_all(dir)
                .and_then(|()| {
                    let temp = dir.join(format!("{OUTBOX_FILE}.{}.tmp", std::process::id()));
                    std::fs::write(&temp, raw).and_then(|()| std::fs::rename(&temp, &file))
                })
                .is_ok(),
            None => std::fs::remove_file(&file).is_ok() || !file.exists(),
        };
        if written {
            self.saved = now;
        }
    }
}
