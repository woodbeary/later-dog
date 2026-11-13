use serde::Deserialize;
use serde_json::Value;

use crate::wire::{WireBot, WireGroup, WireMessage};

pub const RETRY_MIN_MS: u64 = 500;
pub const RETRY_MAX_MS: u64 = 10_000;
pub const STALE_MS: u64 = 40_000;

pub fn retry_delay(attempt: u32) -> u64 {
    RETRY_MAX_MS.min(RETRY_MIN_MS << attempt.min(20))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Hello { cursor: Option<String>, resumed: bool },
    Ping,
    Message { thread_id: String, message: WireMessage },
    MessagePatch { thread_id: String, message: WireMessage },
    Bot { bot: WireBot },
    BotDeleted { bot_id: String },
    Group { group: WireGroup },
    GroupDeleted { group_id: String },
    Other { kind: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloBody {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    resumed: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageBody {
    thread_id: String,
    message: WireMessage,
}

#[derive(Deserialize)]
struct BotBody {
    bot: WireBot,
}

#[derive(Deserialize)]
struct GroupBody {
    group: WireGroup,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupDeletedBody {
    group_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotDeletedBody {
    bot_id: String,
}

impl Frame {
    pub fn parse(data: &str) -> Option<Frame> {
        let value: Value = serde_json::from_str(data).ok()?;
        let kind = value.as_object()?.get("kind")?.as_str()?.to_owned();
        let other = || Frame::Other { kind: kind.clone() };
        let frame = match kind.as_str() {
            "hello" => HelloBody::deserialize(&value)
                .map(|body| Frame::Hello { cursor: body.cursor, resumed: body.resumed.unwrap_or(false) })
                .unwrap_or_else(|_| other()),
            "ping" => Frame::Ping,
            "message" | "message.patch" => match MessageBody::deserialize(&value) {
                Ok(body) if !body.message.id.is_empty() && !body.thread_id.is_empty() => {
                    if kind == "message" {
                        Frame::Message { thread_id: body.thread_id, message: body.message }
                    } else {
                        Frame::MessagePatch { thread_id: body.thread_id, message: body.message }
                    }
                }
                _ => other(),
            },
            "bot" => match BotBody::deserialize(&value) {
                Ok(body) if !body.bot.id.is_empty() => Frame::Bot { bot: body.bot },
                _ => other(),
            },
            "bot.deleted" => match BotDeletedBody::deserialize(&value) {
                Ok(body) if !body.bot_id.is_empty() => Frame::BotDeleted { bot_id: body.bot_id },
                _ => other(),
            },
            "group" => match GroupBody::deserialize(&value) {
                Ok(body) if !body.group.id.is_empty() => Frame::Group { group: body.group },
                _ => other(),
            },
            "group.deleted" => match GroupDeletedBody::deserialize(&value) {
                Ok(body) if !body.group_id.is_empty() => Frame::GroupDeleted { group_id: body.group_id },
                _ => other(),
            },
            _ => other(),
        };
        Some(frame)
    }
}

#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
    skip_newline: bool,
    started: bool,
    data: String,
    has_data: bool,
    event_type: String,
    pending_id: Option<String>,
    last_event_id: Option<String>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn last_event_id(&self) -> Option<&str> {
        self.last_event_id.as_deref()
    }

    pub fn reset_connection(&mut self) {
        self.pending.clear();
        self.skip_newline = false;
        self.started = false;
        self.data.clear();
        self.has_data = false;
        self.event_type.clear();
        self.pending_id = None;
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Frame> {
        let mut frames = Vec::new();
        for &byte in chunk {
            if self.skip_newline {
                self.skip_newline = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\n' | b'\r' => {
                    self.skip_newline = byte == b'\r';
                    let line = std::mem::take(&mut self.pending);
                    if let Some(frame) = self.line(&line) {
                        frames.push(frame);
                    }
                }
                _ => self.pending.push(byte),
            }
        }
        frames
    }

    fn line(&mut self, raw: &[u8]) -> Option<Frame> {
        let mut raw = raw;
        if !self.started {
            self.started = true;
            raw = raw.strip_prefix("\u{feff}".as_bytes()).unwrap_or(raw);
        }
        if raw.is_empty() {
            return self.dispatch();
        }
        if raw.first() == Some(&b':') {
            return None;
        }
        let line = String::from_utf8_lossy(raw);
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line.as_ref(), ""),
        };
        match field {
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "id" if !value.contains('\0') => self.pending_id = Some(value.to_owned()),
            "event" => self.event_type = value.to_owned(),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<Frame> {
        if let Some(id) = self.pending_id.take() {
            self.last_event_id = Some(id);
        }
        let data = std::mem::take(&mut self.data);
        let has_data = std::mem::replace(&mut self.has_data, false);
        let event_type = std::mem::take(&mut self.event_type);
        if !has_data || !(event_type.is_empty() || event_type == "message") {
            return None;
        }
        Frame::parse(&data)
    }
}
