use std::collections::HashMap;

use serde::Serialize;

use crate::events::Frame;
use crate::outbox::{Failure, Item, Outbox, Settled, Target};
use crate::wire::{BotsPage, SendReceipt, ThreadPage, WireBot, WireMessage};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SendState {
    Sending,
    Held,
    Sent,
    NotSent,
}

impl SendState {
    pub fn words(self) -> &'static str {
        match self {
            SendState::Sending => "Sending",
            SendState::Held => "Sends when your home is up",
            SendState::Sent => "Sent",
            SendState::NotSent => "Not sent",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Connection {
    #[default]
    Connecting,
    Connected,
    Reconnecting,
}

impl Connection {
    pub fn words(self) -> &'static str {
        match self {
            Connection::Connecting => "Connecting to your home",
            Connection::Connected => "Connected",
            Connection::Reconnecting => "Reconnecting to your home",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Dog {
    id: String,
    thread_id: String,
    name: String,
    activity: Option<String>,
    busy: bool,
    unread: bool,
    waiting_for_teammates: bool,
}

impl Dog {
    fn from_wire(bot: &WireBot) -> Self {
        let mut dog = Dog { id: bot.id.clone(), ..Dog::default() };
        dog.merge(bot);
        dog
    }

    fn merge(&mut self, bot: &WireBot) {
        if let Some(thread_id) = &bot.thread_id {
            self.thread_id = thread_id.clone();
        }
        if let Some(name) = &bot.name {
            self.name = name.clone();
        }
        if let Some(activity) = &bot.activity {
            self.activity = Some(activity.clone());
        }
        if let Some(busy) = bot.busy {
            self.busy = busy;
        }
        if let Some(unread) = bot.unread {
            self.unread = unread;
        }
        if let Some(waiting) = bot.waiting_for_teammates {
            self.waiting_for_teammates = waiting;
        }
    }

    fn state_word(&self) -> &'static str {
        match self.activity.as_deref() {
            Some("working") => "Working",
            Some("waiting-on-you") => "Needs you",
            Some("no-signal") => "No signal",
            Some("dead") => "Stopped",
            Some("parked.computer") => "Parked",
            _ if self.busy => "Working",
            _ if self.waiting_for_teammates => "Waiting",
            _ => "Idle",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LocalSend {
    item: Item,
    state: SendState,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub sidebar: bool,
    pub transcript: bool,
}

impl Changes {
    fn both() -> Self {
        Changes { sidebar: true, transcript: true }
    }

    pub fn any(self) -> bool {
        self.sidebar || self.transcript
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarRow {
    pub id: String,
    pub name: String,
    pub state: &'static str,
    pub unread: bool,
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRow {
    pub id: String,
    pub who: String,
    pub text: String,
    pub quiet: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub connection: Connection,
    pub status: &'static str,
    pub selected: Option<String>,
    pub title: String,
    pub dogs: Vec<SidebarRow>,
    pub transcript: Vec<TranscriptRow>,
}

pub fn send_id(seed: &[u8; 16], now_ms: u64, counter: u64) -> String {
    fn mix(mut value: u64) -> u64 {
        value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^ (value >> 31)
    }
    let mut low = [0u8; 8];
    let mut high = [0u8; 8];
    low.copy_from_slice(&seed[..8]);
    high.copy_from_slice(&seed[8..]);
    let first = mix(u64::from_le_bytes(low) ^ now_ms);
    let second = mix(u64::from_le_bytes(high) ^ counter ^ now_ms.rotate_left(32) ^ first);
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&first.to_be_bytes());
    bytes[8..].copy_from_slice(&second.to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

pub struct Store {
    dogs: Vec<Dog>,
    threads: HashMap<String, Vec<WireMessage>>,
    sends: Vec<LocalSend>,
    outbox: Outbox,
    selected: Option<String>,
    connection: Connection,
    seed: [u8; 16],
    counter: u64,
}

impl Store {
    pub fn new(seed: [u8; 16]) -> Self {
        Store {
            dogs: Vec::new(),
            threads: HashMap::new(),
            sends: Vec::new(),
            outbox: Outbox::new(),
            selected: None,
            connection: Connection::Connecting,
            seed,
            counter: 0,
        }
    }

    pub fn connection(&self) -> Connection {
        self.connection
    }

    pub fn set_connection(&mut self, connection: Connection) -> Changes {
        let changed = self.connection != connection;
        self.connection = connection;
        Changes { sidebar: changed, transcript: false }
    }

    pub fn selected(&self) -> Option<&str> {
        self.selected.as_deref()
    }

    pub fn selected_thread(&self) -> Option<&str> {
        let selected = self.selected.as_deref()?;
        self.dogs.iter().find(|dog| dog.id == selected).map(|dog| dog.thread_id.as_str())
    }

    pub fn dog_ids(&self) -> Vec<String> {
        self.dogs.iter().map(|dog| dog.id.clone()).collect()
    }

    pub fn find_dog(&self, wanted: &str) -> Option<String> {
        self.dogs
            .iter()
            .find(|dog| dog.id == wanted || dog.name.eq_ignore_ascii_case(wanted))
            .map(|dog| dog.id.clone())
    }

    pub fn thread(&self, thread_id: &str) -> &[WireMessage] {
        self.threads.get(thread_id).map(Vec::as_slice).unwrap_or_default()
    }

    pub fn send_state(&self, send_id: &str) -> Option<SendState> {
        self.sends.iter().find(|send| send.item.send_id == send_id).map(|send| send.state)
    }

    pub fn select(&mut self, bot_id: &str) -> bool {
        if self.selected.as_deref() == Some(bot_id) || !self.dogs.iter().any(|dog| dog.id == bot_id) {
            return false;
        }
        self.selected = Some(bot_id.to_owned());
        true
    }

    pub fn apply_page(&mut self, page: BotsPage) -> Changes {
        self.dogs = page.bots.iter().filter(|bot| !bot.id.is_empty()).map(Dog::from_wire).collect();
        for bot in &page.bots {
            if let (Some(thread_id), Some(messages)) = (&bot.thread_id, &bot.messages) {
                for message in messages {
                    self.upsert(thread_id, message.clone());
                }
            }
        }
        self.keep_selection();
        Changes::both()
    }

    pub fn apply_thread(&mut self, thread_id: &str, page: ThreadPage) -> Changes {
        for message in page.messages {
            self.upsert(thread_id, message);
        }
        Changes { sidebar: false, transcript: self.selected_thread() == Some(thread_id) }
    }

    pub fn apply_frame(&mut self, frame: &Frame) -> Changes {
        match frame {
            Frame::Hello { .. } => self.set_connection(Connection::Connected),
            Frame::Message { thread_id, message } | Frame::MessagePatch { thread_id, message } => {
                self.upsert(thread_id, message.clone());
                Changes { sidebar: false, transcript: self.selected_thread() == Some(thread_id.as_str()) }
            }
            Frame::Bot { bot } => {
                match self.dogs.iter_mut().find(|dog| dog.id == bot.id) {
                    Some(dog) => dog.merge(bot),
                    None => self.dogs.insert(0, Dog::from_wire(bot)),
                }
                let mut changes = Changes { sidebar: true, transcript: false };
                if let (Some(thread_id), Some(messages)) = (&bot.thread_id, &bot.messages) {
                    for message in messages {
                        self.upsert(thread_id, message.clone());
                    }
                    changes.transcript = self.selected_thread() == Some(thread_id.as_str());
                }
                self.keep_selection();
                changes
            }
            Frame::BotDeleted { bot_id } => {
                self.dogs.retain(|dog| &dog.id != bot_id);
                self.keep_selection();
                Changes::both()
            }
            Frame::Ping | Frame::Other { .. } => Changes::default(),
        }
    }

    pub fn compose(&mut self, text: &str, now_ms: u64) -> Option<Item> {
        if text.trim().is_empty() {
            return None;
        }
        let dog = self.dogs.iter().find(|dog| Some(&dog.id) == self.selected.as_ref())?;
        self.counter += 1;
        let item = Item {
            send_id: send_id(&self.seed, now_ms, self.counter),
            thread_id: dog.thread_id.clone(),
            target: Target::Bot { bot_id: dog.id.clone(), deliver: None },
            text: text.to_owned(),
            reply_to_id: None,
            queued_at: now_ms,
        };
        if !self.outbox.enqueue(item.clone()) {
            return None;
        }
        self.sends.push(LocalSend { item: item.clone(), state: SendState::Sending });
        Some(item)
    }

    pub fn due(&mut self, now_ms: u64) -> Vec<Item> {
        self.outbox.due(now_ms)
    }

    pub fn next_wake_ms(&self) -> Option<u64> {
        self.outbox.next_wake_ms()
    }

    pub fn send_succeeded(&mut self, send_id: &str, receipt: SendReceipt) -> Changes {
        self.outbox.delivered(send_id);
        let thread = self.set_send_state(send_id, SendState::Sent);
        if let (Some(message), Some(thread_id)) = (receipt.message, receipt.thread_id.or_else(|| thread.clone())) {
            if !message.id.is_empty() {
                self.upsert(&thread_id, message);
            }
        }
        Changes { sidebar: false, transcript: thread.as_deref().is_some_and(|thread| self.selected_thread() == Some(thread)) }
    }

    pub fn send_failed(&mut self, send_id: &str, failure: &Failure, now_ms: u64) -> Changes {
        let state = match self.outbox.failed(send_id, failure, now_ms) {
            Settled::Held { .. } => SendState::Held,
            Settled::Final { .. } => SendState::NotSent,
            Settled::Gone => return Changes::default(),
        };
        let thread = self.set_send_state(send_id, state);
        Changes { sidebar: false, transcript: thread.as_deref().is_some_and(|thread| self.selected_thread() == Some(thread)) }
    }

    pub fn view(&self) -> View {
        let selected = self.dogs.iter().find(|dog| Some(&dog.id) == self.selected.as_ref());
        View {
            connection: self.connection,
            status: self.connection.words(),
            selected: selected.map(|dog| dog.id.clone()),
            title: selected.map(|dog| dog.name.clone()).unwrap_or_default(),
            dogs: self
                .dogs
                .iter()
                .map(|dog| SidebarRow {
                    id: dog.id.clone(),
                    name: dog.name.clone(),
                    state: dog.state_word(),
                    unread: dog.unread,
                    selected: Some(&dog.id) == self.selected.as_ref(),
                })
                .collect(),
            transcript: selected.map(|dog| self.transcript(dog)).unwrap_or_default(),
        }
    }

    fn transcript(&self, dog: &Dog) -> Vec<TranscriptRow> {
        let messages = self.thread(&dog.thread_id);
        let mut rows: Vec<TranscriptRow> = messages.iter().filter_map(|message| self.row(dog, message)).collect();
        for send in &self.sends {
            let landed = messages.iter().any(|message| message.send_id.as_deref() == Some(send.item.send_id.as_str()));
            if send.item.thread_id == dog.thread_id && !landed {
                rows.push(TranscriptRow {
                    id: format!("send:{}", send.item.send_id),
                    who: "You".to_owned(),
                    text: send.item.text.clone(),
                    quiet: false,
                    status: Some(send.state.words()),
                });
            }
        }
        rows
    }

    fn row(&self, dog: &Dog, message: &WireMessage) -> Option<TranscriptRow> {
        let who = if message.is_from_person() { "You".to_owned() } else { dog.name.clone() };
        let (text, quiet) = match message.kind.as_str() {
            "digest" | "compaction" => return None,
            "activity" => {
                let tool = message.tool.as_ref()?;
                let line = tool.spoken.clone().or_else(|| tool.summary.clone()).unwrap_or_else(|| tool.name.clone());
                (line, true)
            }
            _ => (message.text.clone().unwrap_or_default(), false),
        };
        if text.trim().is_empty() {
            return None;
        }
        let status = message.send_id.as_deref().and_then(|send_id| self.send_state(send_id)).map(SendState::words);
        Some(TranscriptRow { id: message.id.clone(), who, text, quiet, status })
    }

    fn set_send_state(&mut self, send_id: &str, state: SendState) -> Option<String> {
        let send = self.sends.iter_mut().find(|send| send.item.send_id == send_id)?;
        send.state = state;
        Some(send.item.thread_id.clone())
    }

    fn upsert(&mut self, thread_id: &str, message: WireMessage) {
        if message.id.is_empty() {
            return;
        }
        let messages = self.threads.entry(thread_id.to_owned()).or_default();
        if let Some(existing) = messages.iter_mut().find(|existing| existing.id == message.id) {
            *existing = message;
            return;
        }
        let at = message.at;
        let position = messages.iter().rposition(|existing| existing.at <= at).map_or(0, |index| index + 1);
        messages.insert(position, message);
    }

    fn keep_selection(&mut self) {
        let present = self.selected.as_ref().is_some_and(|selected| self.dogs.iter().any(|dog| &dog.id == selected));
        if !present {
            self.selected = self.dogs.first().map(|dog| dog.id.clone());
        }
    }
}
