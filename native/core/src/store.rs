use std::collections::HashMap;

use serde::Serialize;

use crate::events::Frame;
use crate::outbox::{Failure, Item, Outbox, Settled, Target};
use crate::exchange::ExchangeLine;
use crate::work::Work;
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
    color: Option<String>,
    body: Option<String>,
    section: Option<String>,
    pinned: bool,
    hidden: bool,
    chief: bool,
    model: Option<String>,
    busy: bool,
    unread: bool,
    waiting_for_teammates: bool,
    work: Option<Work>,
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
        if let Some(color) = &bot.color {
            self.color = Some(color.clone());
        }
        if let Some(body) = &bot.mascot_body {
            self.body = Some(body.clone());
        }
        if bot.section.is_some() || bot.pinned.is_some() {
            self.section = bot.section.clone().filter(|section| !section.is_empty());
        }
        if let Some(pinned) = bot.pinned {
            self.pinned = pinned;
        }
        if let Some(hidden) = bot.hidden {
            self.hidden = hidden;
        }
        if let Some(chief) = bot.chief_of_staff {
            self.chief = chief;
        }
        if let Some(model) = bot.model_selection.as_ref().and_then(|selection| selection.model.clone()) {
            self.model = Some(model);
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
        if let Some(work) = &bot.work {
            self.work = work.clone();
        }
    }

    fn working(&self) -> bool {
        match self.activity.as_deref() {
            Some(activity) => activity == "working",
            None => self.busy,
        }
    }

    fn waiting(&self) -> bool {
        self.activity.as_deref() == Some("waiting-on-you")
    }

    fn color(&self) -> String {
        self.color.clone().filter(|color| !color.is_empty()).unwrap_or_else(|| DEFAULT_COLOR.to_owned())
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

pub const DEFAULT_COLOR: &str = "yellow";

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
    pub color: String,
    pub body: String,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_at: Option<u64>,
    pub working: bool,
    pub waiting: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<Work>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SidebarEntry {
    Header { name: String, count: usize, first: bool },
    Dog { index: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RowKind {
    Text,
    Work,
    Exchange,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRow {
    pub id: String,
    pub kind: RowKind,
    pub who: String,
    pub mine: bool,
    pub text: String,
    pub quiet: bool,
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange: Option<ExchangeLine>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub connection: Connection,
    pub status: &'static str,
    pub selected: Option<String>,
    pub title: String,
    pub color: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<Work>,
    pub dogs: Vec<SidebarRow>,
    pub sidebar: Vec<SidebarEntry>,
    pub transcript: Vec<TranscriptRow>,
}

fn preview_of(message: &WireMessage) -> String {
    let text = message.text.as_deref().unwrap_or_default();
    if message.is_from_person() {
        first_line(text)
    } else {
        crate::markdown::preview(text)
    }
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default().to_owned()
}

pub fn unreads_out_of_view(rows: &[(f64, f64)], top: f64, bottom: f64) -> (usize, usize) {
    let above = rows.iter().filter(|(_, row_bottom)| *row_bottom <= top + 1.0).count();
    let below = rows.iter().filter(|(row_top, row_bottom)| *row_bottom > top + 1.0 && *row_top >= bottom - 1.0).count();
    (above, below)
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
    sections: Vec<String>,
    more: HashMap<String, bool>,
    loading_older: Vec<String>,
    asked_read: Vec<String>,
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
            sections: Vec::new(),
            more: HashMap::new(),
            loading_older: Vec::new(),
            asked_read: Vec::new(),
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
        self.sections = page.sections.clone();
        for bot in &page.bots {
            if let (Some(thread_id), Some(more)) = (&bot.thread_id, bot.has_more) {
                self.more.entry(thread_id.clone()).or_insert(more);
            }
        }
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

    pub fn has_older(&self, thread_id: &str) -> bool {
        self.more.get(thread_id).copied().unwrap_or(false)
    }

    pub fn older_request(&mut self) -> Option<(String, String)> {
        let thread_id = self.selected_thread()?.to_owned();
        if !self.has_older(&thread_id) || self.loading_older.contains(&thread_id) {
            return None;
        }
        let oldest = self.thread(&thread_id).first()?.id.clone();
        self.loading_older.push(thread_id.clone());
        Some((thread_id, oldest))
    }

    pub fn apply_older(&mut self, thread_id: &str, page: ThreadPage) -> Changes {
        self.loading_older.retain(|loading| loading != thread_id);
        self.more.insert(thread_id.to_owned(), page.has_more.unwrap_or(false));
        self.apply_thread(thread_id, page)
    }

    pub fn older_failed(&mut self, thread_id: &str) {
        self.loading_older.retain(|loading| loading != thread_id);
    }

    pub fn read_request(&mut self) -> Option<(String, String)> {
        let dog = self.dogs.iter().find(|dog| Some(&dog.id) == self.selected.as_ref() && dog.unread)?;
        if self.asked_read.contains(&dog.id) {
            return None;
        }
        let ask = (dog.id.clone(), dog.thread_id.clone());
        self.asked_read.push(ask.0.clone());
        Some(ask)
    }

    pub fn read_answered(&mut self, bot_id: &str) {
        self.asked_read.retain(|asked| asked != bot_id);
    }

    pub fn saved_outbox(&self) -> Option<String> {
        self.outbox.saved()
    }

    pub fn restore_outbox(&mut self, raw: &str) -> usize {
        let items = crate::outbox::parse_saved(raw);
        let count = items.len();
        for item in &items {
            if !self.sends.iter().any(|send| send.item.send_id == item.send_id) {
                self.sends.push(LocalSend { item: item.clone(), state: SendState::Sending });
            }
        }
        self.outbox.restore(items);
        count
    }

    pub fn compose_to(&mut self, bot_id: &str, thread_id: &str, text: &str, now_ms: u64) -> Option<Item> {
        if text.trim().is_empty() || bot_id.is_empty() || thread_id.is_empty() {
            return None;
        }
        self.counter += 1;
        let item = Item {
            send_id: send_id(&self.seed, now_ms, self.counter),
            thread_id: thread_id.to_owned(),
            target: Target::Bot { bot_id: bot_id.to_owned(), deliver: None },
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

    pub fn send_again(&mut self, send_id: &str) -> Option<Item> {
        let send = self.sends.iter_mut().find(|send| send.item.send_id == send_id && send.state == SendState::NotSent)?;
        if !self.outbox.enqueue(send.item.clone()) {
            return None;
        }
        send.state = SendState::Sending;
        Some(send.item.clone())
    }

    pub fn unsettled_sends(&self) -> usize {
        self.sends.iter().filter(|send| matches!(send.state, SendState::Sending | SendState::Held)).count()
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
                if bot.unread == Some(false) {
                    self.read_answered(&bot.id);
                }
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
        let dog = self.dogs.iter().find(|dog| Some(&dog.id) == self.selected.as_ref())?;
        let (bot_id, thread_id) = (dog.id.clone(), dog.thread_id.clone());
        self.compose_to(&bot_id, &thread_id, text, now_ms)
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
            color: selected.map(Dog::color).unwrap_or_else(|| DEFAULT_COLOR.to_owned()),
            body: crate::mascot::body(selected.and_then(|dog| dog.body.as_deref())).to_owned(),
            model: selected.and_then(|dog| dog.model.clone()),
            work: selected.and_then(|dog| dog.work.clone()),
            dogs: self
                .sidebar_order()
                .into_iter()
                .map(|dog| {
                    let last = self.last_words(dog);
                    SidebarRow {
                        id: dog.id.clone(),
                        name: dog.name.clone(),
                        state: dog.state_word(),
                        unread: dog.unread,
                        selected: Some(&dog.id) == self.selected.as_ref(),
                        color: dog.color(),
                        body: crate::mascot::body(dog.body.as_deref()).to_owned(),
                        preview: last.map(preview_of).unwrap_or_default(),
                        last_at: last.map(|message| message.at),
                        working: dog.working(),
                        waiting: dog.waiting(),
                        work: dog.work.clone(),
                    }
                })
                .collect(),
            sidebar: self.sidebar_entries(),
            transcript: selected.map(|dog| self.transcript(dog)).unwrap_or_default(),
        }
    }

    fn section_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = Vec::new();
        for name in self.sections.iter().map(String::as_str) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        for dog in self.dogs.iter().filter(|dog| !dog.hidden && !dog.pinned) {
            if let Some(section) = dog.section.as_deref() {
                if !names.contains(&section) {
                    names.push(section);
                }
            }
        }
        names
    }

    fn sidebar_entries(&self) -> Vec<SidebarEntry> {
        let order = self.sidebar_order();
        let names = self.section_names();
        let mut entries = Vec::with_capacity(order.len() + names.len() + 1);
        let pinned = order.iter().take_while(|dog| dog.pinned).count();
        entries.extend((0..pinned).map(|index| SidebarEntry::Dog { index }));
        if names.is_empty() {
            entries.extend((pinned..order.len()).map(|index| SidebarEntry::Dog { index }));
            return entries;
        }
        let mut groups: Vec<(String, Vec<usize>)> = names.iter().map(|name| ((*name).to_owned(), Vec::new())).collect();
        let mut rest = Vec::new();
        for (index, dog) in order.iter().enumerate().skip(pinned) {
            match dog.section.as_deref().and_then(|section| groups.iter().position(|(name, _)| name == section)) {
                Some(group) => groups[group].1.push(index),
                None => rest.push(index),
            }
        }
        groups.push((crate::words::SECTION_UNASSIGNED.to_owned(), rest));
        for (position, (name, members)) in groups.into_iter().enumerate() {
            entries.push(SidebarEntry::Header { name, count: members.len(), first: position == 0 });
            entries.extend(members.into_iter().map(|index| SidebarEntry::Dog { index }));
        }
        entries
    }

    fn sidebar_order(&self) -> Vec<&Dog> {
        let shown: Vec<&Dog> = self.dogs.iter().filter(|dog| !dog.hidden).collect();
        let mut pinned: Vec<&Dog> = shown.iter().copied().filter(|dog| dog.pinned).collect();
        pinned.sort_by_key(|dog| !dog.chief);
        let mut names: Vec<&str> = self.sections.iter().map(String::as_str).collect();
        for dog in &shown {
            if let Some(section) = dog.section.as_deref().filter(|_| !dog.pinned) {
                if !names.contains(&section) {
                    names.push(section);
                }
            }
        }
        let sectioned = names.into_iter().flat_map(|name| shown.iter().copied().filter(move |dog| !dog.pinned && dog.section.as_deref() == Some(name)));
        let rest = shown.iter().copied().filter(|dog| !dog.pinned && dog.section.is_none());
        pinned.into_iter().chain(sectioned).chain(rest).collect()
    }

    fn last_words<'a>(&'a self, dog: &Dog) -> Option<&'a WireMessage> {
        self.thread(&dog.thread_id)
            .iter()
            .rev()
            .find(|message| !matches!(message.kind.as_str(), "activity" | "digest" | "compaction") && message.text.as_deref().is_some_and(|text| !text.trim().is_empty()))
    }

    fn transcript(&self, dog: &Dog) -> Vec<TranscriptRow> {
        let messages = self.thread(&dog.thread_id);
        let mut rows: Vec<TranscriptRow> = Vec::new();
        let mut folded: Vec<&str> = Vec::new();
        for (index, message) in messages.iter().enumerate() {
            if folded.contains(&message.id.as_str()) {
                continue;
            }
            match message.kind.as_str() {
                "digest" | "compaction" => {}
                "activity" => {
                    let Some(tool) = message.tool.as_ref() else { continue };
                    if let Some((line, used)) = self.exchange_line(message, messages.get(index + 1)) {
                        if let Some(used) = used {
                            folded.push(used);
                        }
                        rows.push(TranscriptRow {
                            id: message.id.clone(),
                            kind: RowKind::Exchange,
                            who: dog.name.clone(),
                            mine: false,
                            text: line.spoken(),
                            quiet: true,
                            at: message.at,
                            status: None,
                            send_id: None,
                            exchange: Some(line),
                        });
                        continue;
                    }
                    let line = tool.spoken.clone().or_else(|| tool.summary.clone()).unwrap_or_else(|| tool.name.clone());
                    match rows.last_mut() {
                        Some(row) if row.kind == RowKind::Work => {
                            row.text = line;
                            row.at = message.at;
                        }
                        _ => rows.push(TranscriptRow {
                            id: message.id.clone(),
                            kind: RowKind::Work,
                            who: dog.name.clone(),
                            mine: false,
                            text: line,
                            quiet: true,
                            at: message.at,
                            status: None,
                            send_id: None,
                            exchange: None,
                        }),
                    }
                }
                _ => rows.extend(self.row(dog, message)),
            }
        }
        for send in &self.sends {
            let landed = messages.iter().any(|message| message.send_id.as_deref() == Some(send.item.send_id.as_str()));
            if send.item.thread_id == dog.thread_id && !landed {
                rows.push(TranscriptRow {
                    id: format!("send:{}", send.item.send_id),
                    kind: RowKind::Text,
                    who: "You".to_owned(),
                    mine: true,
                    text: send.item.text.clone(),
                    quiet: false,
                    at: send.item.queued_at,
                    status: Some(send.state.words()),
                    send_id: Some(send.item.send_id.clone()),
                    exchange: None,
                });
            }
        }
        rows
    }

    fn row(&self, dog: &Dog, message: &WireMessage) -> Option<TranscriptRow> {
        let mine = message.is_from_person();
        let text = message.text.clone().unwrap_or_default();
        if text.trim().is_empty() {
            return None;
        }
        let status = message.send_id.as_deref().and_then(|send_id| self.send_state(send_id)).map(SendState::words);
        Some(TranscriptRow {
            id: message.id.clone(),
            kind: RowKind::Text,
            who: if mine { "You".to_owned() } else { dog.name.clone() },
            mine,
            text,
            quiet: false,
            at: message.at,
            status,
            send_id: message.send_id.clone(),
            exchange: None,
        })
    }

    fn exchange_line<'a>(&self, message: &WireMessage, next: Option<&'a WireMessage>) -> Option<(ExchangeLine, Option<&'a str>)> {
        let tool = message.tool.as_ref()?;
        let comm = message.comm.as_ref()?;
        let label = crate::exchange::label(comm.direction.as_deref(), &tool.name)?;
        let request = next.filter(|next| {
            next.role == "bot"
                && next.kind == "text"
                && next.room_request.as_ref().is_some_and(|request| request.phase == "request")
                && next.exchange.is_some()
                && message.exchange.is_none()
        });
        let record = message.exchange.as_ref().or_else(|| request.and_then(|next| next.exchange.as_ref()))?;
        let peer = self.dogs.iter().find(|candidate| candidate.id == comm.with_bot_id);
        let name = peer.map(|peer| peer.name.clone()).filter(|name| !name.is_empty()).unwrap_or_else(|| comm.with_name.clone());
        let color = peer.map(Dog::color).unwrap_or_else(|| if comm.with_color.is_empty() { "blue".to_owned() } else { comm.with_color.clone() });
        let line = ExchangeLine {
            label,
            dog_id: comm.with_bot_id.clone(),
            name,
            color,
            body: crate::mascot::body(peer.and_then(|peer| peer.body.as_deref())).to_owned(),
            gist: crate::exchange::gist(&record.request),
            state: crate::exchange::state(record),
            details: crate::exchange::details(record),
        };
        Some((line, request.map(|next| next.id.as_str())))
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
        let present = self.selected.as_ref().is_some_and(|selected| self.dogs.iter().any(|dog| &dog.id == selected && !dog.hidden));
        if !present {
            self.selected = self.sidebar_order().first().map(|dog| dog.id.clone());
        }
    }
}
