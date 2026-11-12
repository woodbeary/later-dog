use std::collections::HashMap;

use serde::Serialize;

use crate::cards::{self, CardKind, Decision, QuestionDraft, RespondFailure};
use crate::events::Frame;
use crate::outbox::{CardRef, Failure, Item, Outbox, Settled, Target};
use crate::exchange::ExchangeLine;
use crate::receipt::RanBlock;
use crate::work::Work;
use crate::wire::{BotsPage, SendReceipt, ThreadPage, WireBot, WireCard, WireGroup, WireMessage};

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
    always_allow: Vec<String>,
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
        if let Some(always) = &bot.always_allow {
            self.always_allow = always.clone();
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
pub const ROOM_BOT_WORKING: &str = "{name} is working\u{2026}";
pub const ROOM_A_BOT: &str = "A dog";
pub const ROOM_TEAM_WORKING: &str = "The dogs are working\u{2026}";
pub const ROOM_NO_MESSAGES: &str = "No messages yet";
pub const ROOM_YOU: &str = "You: {text}";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Room {
    id: String,
    thread_id: String,
    name: String,
    member_ids: Vec<String>,
    unread: bool,
    section: Option<String>,
    busy_bot_id: Option<String>,
    working: bool,
    dm: bool,
    work: Option<Work>,
}

impl Room {
    fn from_wire(group: &WireGroup) -> Self {
        let mut room = Room { id: group.id.clone(), ..Room::default() };
        room.merge(group);
        room
    }

    fn merge(&mut self, group: &WireGroup) {
        if let Some(thread_id) = group.thread_id.as_ref().filter(|thread| !thread.is_empty()) {
            self.thread_id = thread_id.clone();
        }
        if let Some(name) = &group.name {
            self.name = name.clone();
        }
        if let Some(members) = &group.member_ids {
            self.member_ids = members.clone();
        }
        if let Some(unread) = group.unread {
            self.unread = unread;
        }
        self.section = group.section.clone().filter(|section| !section.is_empty());
        self.busy_bot_id = group.busy_bot_id.clone().filter(|id| !id.is_empty());
        if let Some(working) = group.working {
            self.working = working;
        }
        if let Some(dm) = group.dm {
            self.dm = dm;
        }
        if let Some(work) = &group.work {
            self.work = work.clone();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answered {
    Pending,
    Sent,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Responding {
    message_id: String,
    thread_id: String,
    shown: Option<String>,
    closing: bool,
    state: Answered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub path: String,
    pub method: &'static str,
    pub body: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Respond {
    pub key: String,
    pub thread_id: String,
    pub body: serde_json::Value,
    pub body_without_grant: Option<serde_json::Value>,
    pub grant: Option<Grant>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardPatch {
    pub path: String,
    pub body: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CardAction {
    Send(Item),
    Respond(Respond),
    Patch(CardPatch),
    Nothing,
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
    Room { index: usize },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Face {
    pub name: String,
    pub color: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomRow {
    pub id: String,
    pub name: String,
    pub unread: bool,
    pub selected: bool,
    pub faces: Vec<Face>,
    pub extra: usize,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FoldIcon {
    Check,
    Minus,
    Cross,
    Sending,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub letter: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub picked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionTab {
    pub label: String,
    pub current: bool,
    pub answered: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum QuestionFooter {
    None,
    Steps { back: bool, next: &'static str, next_enabled: bool, last: bool },
    Submit { enabled: bool },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CardLine {
    Options {
        message_id: String,
        title: String,
        subtitle: String,
        choices: Vec<String>,
        custom: bool,
        dismiss: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Question {
        message_id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        actor: Option<String>,
        origin: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        tabs: Vec<QuestionTab>,
        question: String,
        multi: bool,
        options: Vec<QuestionOption>,
        other_letter: String,
        other: bool,
        custom: String,
        footer: QuestionFooter,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Waiting {
        line: String,
        note: &'static str,
    },
    Folded {
        icon: FoldIcon,
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        trailing: Option<String>,
        label: String,
        centered: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPanel {
    pub message_id: String,
    pub request_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    pub detail: String,
    pub reviewed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held: Option<String>,
    pub decisions: Vec<Decision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reach: Option<String>,
    pub sending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RowKind {
    Text,
    Work,
    Exchange,
    Card,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face: Option<Face>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<CardLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ran: Option<RanBlock>,
    pub room: bool,
}

impl TranscriptRow {
    fn quiet(id: &str, kind: RowKind, who: &str, text: String, at: u64) -> Self {
        TranscriptRow { id: id.to_owned(), kind, who: who.to_owned(), mine: false, text, quiet: true, at, status: None, send_id: None, exchange: None, face: None, card: None, ran: None, room: false }
    }
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
    pub room: bool,
    pub dogs: Vec<SidebarRow>,
    pub rooms: Vec<RoomRow>,
    pub sidebar: Vec<SidebarEntry>,
    pub transcript: Vec<TranscriptRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<ApprovalPanel>,
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

#[derive(Clone, Copy)]
enum Chat<'a> {
    Dog(&'a Dog),
    Room(&'a Room),
}

impl Chat<'_> {
    fn thread_id(&self) -> &str {
        match self {
            Chat::Dog(dog) => &dog.thread_id,
            Chat::Room(room) => &room.thread_id,
        }
    }
}

pub struct Store {
    dogs: Vec<Dog>,
    rooms: Vec<Room>,
    sections: Vec<String>,
    more: HashMap<String, bool>,
    loading_older: Vec<String>,
    asked_read: Vec<String>,
    threads: HashMap<String, Vec<WireMessage>>,
    sends: Vec<LocalSend>,
    outbox: Outbox,
    selected: Option<String>,
    connection: Connection,
    drafts: HashMap<String, QuestionDraft>,
    responding: HashMap<String, Responding>,
    picked: HashMap<String, String>,
    patches: Vec<CardPatch>,
    seed: [u8; 16],
    counter: u64,
}

impl Store {
    pub fn new(seed: [u8; 16]) -> Self {
        Store {
            dogs: Vec::new(),
            rooms: Vec::new(),
            sections: Vec::new(),
            more: HashMap::new(),
            loading_older: Vec::new(),
            asked_read: Vec::new(),
            threads: HashMap::new(),
            sends: Vec::new(),
            outbox: Outbox::new(),
            selected: None,
            connection: Connection::Connecting,
            drafts: HashMap::new(),
            responding: HashMap::new(),
            picked: HashMap::new(),
            patches: Vec::new(),
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

    fn chat(&self) -> Option<Chat<'_>> {
        let selected = self.selected.as_deref()?;
        if let Some(dog) = self.dogs.iter().find(|dog| dog.id == selected) {
            return Some(Chat::Dog(dog));
        }
        self.rooms.iter().find(|room| room.id == selected).map(Chat::Room)
    }

    pub fn selected_thread(&self) -> Option<&str> {
        match self.chat()? {
            Chat::Dog(dog) => Some(dog.thread_id.as_str()),
            Chat::Room(room) => Some(room.thread_id.as_str()),
        }
    }

    pub fn selected_room(&self) -> bool {
        matches!(self.chat(), Some(Chat::Room(_)))
    }

    pub fn dog_ids(&self) -> Vec<String> {
        self.dogs.iter().map(|dog| dog.id.clone()).collect()
    }

    pub fn find_dog(&self, wanted: &str) -> Option<String> {
        self.dogs
            .iter()
            .find(|dog| dog.id == wanted || dog.name.eq_ignore_ascii_case(wanted))
            .map(|dog| dog.id.clone())
            .or_else(|| self.rooms.iter().find(|room| room.id == wanted || room.name.eq_ignore_ascii_case(wanted)).map(|room| room.id.clone()))
    }

    pub fn thread(&self, thread_id: &str) -> &[WireMessage] {
        self.threads.get(thread_id).map(Vec::as_slice).unwrap_or_default()
    }

    pub fn send_state(&self, send_id: &str) -> Option<SendState> {
        self.sends.iter().find(|send| send.item.send_id == send_id).map(|send| send.state)
    }

    pub fn select(&mut self, id: &str) -> bool {
        let known = self.dogs.iter().any(|dog| dog.id == id) || self.rooms.iter().any(|room| room.id == id && !room.dm);
        if self.selected.as_deref() == Some(id) || !known {
            return false;
        }
        self.selected = Some(id.to_owned());
        true
    }

    pub fn apply_page(&mut self, page: BotsPage) -> Changes {
        self.dogs = page.bots.iter().filter(|bot| !bot.id.is_empty()).map(Dog::from_wire).collect();
        self.rooms = page.groups.iter().filter(|group| !group.id.is_empty()).map(Room::from_wire).collect();
        self.sections = page.sections.clone();
        let threads = page.bots.iter().map(|bot| (&bot.thread_id, bot.has_more, &bot.messages)).chain(page.groups.iter().map(|group| (&group.thread_id, group.has_more, &group.messages)));
        let threads: Vec<(Option<String>, Option<bool>, Option<Vec<WireMessage>>)> = threads.map(|(thread, more, messages)| (thread.clone(), more, messages.clone())).collect();
        for (thread_id, more, messages) in threads {
            let Some(thread_id) = thread_id else { continue };
            if let Some(more) = more {
                self.more.entry(thread_id.clone()).or_insert(more);
            }
            for message in messages.unwrap_or_default() {
                self.upsert(&thread_id, message);
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

    pub fn read_request(&mut self) -> Option<(String, String, bool)> {
        let ask = match self.chat()? {
            Chat::Dog(dog) if dog.unread => (dog.id.clone(), dog.thread_id.clone(), false),
            Chat::Room(room) if room.unread => (room.id.clone(), room.thread_id.clone(), true),
            _ => return None,
        };
        if self.asked_read.contains(&ask.0) {
            return None;
        }
        self.asked_read.push(ask.0.clone());
        Some(ask)
    }

    pub fn read_answered(&mut self, id: &str) {
        self.asked_read.retain(|asked| asked != id);
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

    fn queue(&mut self, target: Target, thread_id: &str, text: &str, now_ms: u64, card: Option<CardRef>) -> Option<Item> {
        if text.trim().is_empty() || thread_id.is_empty() {
            return None;
        }
        let empty_target = match &target {
            Target::Bot { bot_id, .. } => bot_id.is_empty(),
            Target::Group { group_id } => group_id.is_empty(),
        };
        if empty_target {
            return None;
        }
        self.counter += 1;
        let item = Item {
            send_id: send_id(&self.seed, now_ms, self.counter),
            thread_id: thread_id.to_owned(),
            target,
            text: text.to_owned(),
            reply_to_id: None,
            queued_at: now_ms,
            card,
        };
        if !self.outbox.enqueue(item.clone()) {
            return None;
        }
        self.sends.push(LocalSend { item: item.clone(), state: SendState::Sending });
        Some(item)
    }

    pub fn compose_to(&mut self, bot_id: &str, thread_id: &str, text: &str, now_ms: u64) -> Option<Item> {
        self.queue(Target::Bot { bot_id: bot_id.to_owned(), deliver: None }, thread_id, text, now_ms, None)
    }

    pub fn compose_to_room(&mut self, group_id: &str, thread_id: &str, text: &str, now_ms: u64) -> Option<Item> {
        self.queue(Target::Group { group_id: group_id.to_owned() }, thread_id, text, now_ms, None)
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
                let mut changes = Changes { sidebar: true, transcript: self.selected_room() };
                if let (Some(thread_id), Some(messages)) = (&bot.thread_id, &bot.messages) {
                    for message in messages {
                        self.upsert(thread_id, message.clone());
                    }
                    changes.transcript |= self.selected_thread() == Some(thread_id.as_str());
                }
                self.keep_selection();
                changes
            }
            Frame::BotDeleted { bot_id } => {
                self.dogs.retain(|dog| &dog.id != bot_id);
                self.keep_selection();
                Changes::both()
            }
            Frame::Group { group } => {
                if group.unread == Some(false) {
                    self.read_answered(&group.id);
                }
                match self.rooms.iter_mut().find(|room| room.id == group.id) {
                    Some(room) => room.merge(group),
                    None => self.rooms.insert(0, Room::from_wire(group)),
                }
                let mut changes = Changes { sidebar: true, transcript: self.selected.as_deref() == Some(group.id.as_str()) };
                if let (Some(thread_id), Some(messages)) = (&group.thread_id, &group.messages) {
                    for message in messages {
                        self.upsert(thread_id, message.clone());
                    }
                    changes.transcript |= self.selected_thread() == Some(thread_id.as_str());
                }
                self.keep_selection();
                changes
            }
            Frame::GroupDeleted { group_id } => {
                self.rooms.retain(|room| &room.id != group_id);
                self.keep_selection();
                Changes::both()
            }
            Frame::Ping | Frame::Other { .. } => Changes::default(),
        }
    }

    pub fn compose(&mut self, text: &str, now_ms: u64) -> Option<Item> {
        match self.chat()? {
            Chat::Dog(dog) => {
                let (bot_id, thread_id) = (dog.id.clone(), dog.thread_id.clone());
                self.compose_to(&bot_id, &thread_id, text, now_ms)
            }
            Chat::Room(room) => {
                let (group_id, thread_id) = (room.id.clone(), room.thread_id.clone());
                self.compose_to_room(&group_id, &thread_id, text, now_ms)
            }
        }
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
        let card = self.sends.iter().find(|send| send.item.send_id == send_id).and_then(|send| send.item.card.clone().map(|card| (card, send.item.text.clone(), send.item.thread_id.clone())));
        if let Some((card, answer, thread_id)) = card {
            self.card_answered(&card, &answer, &thread_id);
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

    fn card_answered(&mut self, card: &CardRef, answer: &str, thread_id: &str) {
        if let Some(message) = self.threads.get_mut(thread_id).and_then(|messages| messages.iter_mut().find(|message| message.id == card.message_id)) {
            if let Some(wire) = message.card.as_mut() {
                wire.answered = Some(answer.to_owned());
                if card.group_id.is_none() {
                    wire.dismissed = true;
                }
            }
        }
        let patch = match &card.group_id {
            Some(group_id) => CardPatch {
                path: format!("/api/groups/{group_id}/cards/{}", card.message_id),
                body: serde_json::json!({ "answered": answer, "dismissed": true, "threadId": thread_id }),
            },
            None => CardPatch { path: format!("/api/bots/{}/cards/{}", card.bot_id, card.message_id), body: serde_json::json!({ "answered": answer, "dismissed": true }) },
        };
        self.patches.push(patch);
    }

    pub fn take_patches(&mut self) -> Vec<CardPatch> {
        std::mem::take(&mut self.patches)
    }

    fn find_card(&self, message_id: &str) -> Option<(String, &WireMessage, &WireCard)> {
        let thread_id = self.selected_thread()?;
        let message = self.thread(thread_id).iter().find(|message| message.id == message_id)?;
        Some((thread_id.to_owned(), message, message.card.as_ref()?))
    }

    fn owner_of(&self, message: &WireMessage) -> Option<(String, String)> {
        match self.chat()? {
            Chat::Dog(dog) => Some((dog.id.clone(), dog.name.clone())),
            Chat::Room(_) => {
                let from = message.from.as_ref()?;
                let name = self.dogs.iter().find(|dog| dog.id == from.bot_id).map(|dog| dog.name.clone()).unwrap_or_else(|| from.name.clone());
                Some((from.bot_id.clone(), name))
            }
        }
    }

    pub fn answer_card(&mut self, message_id: &str, answer: &str, now_ms: u64) -> CardAction {
        let answer = answer.trim();
        let Some((thread_id, message, card)) = self.find_card(message_id) else { return CardAction::Nothing };
        if answer.is_empty() || card.answered.is_some() || self.card_pending(message_id) {
            return CardAction::Nothing;
        }
        if cards::kind(card) != CardKind::Options {
            return CardAction::Nothing;
        }
        let owner = self.owner_of(message);
        let room = match self.chat() {
            Some(Chat::Room(room)) => Some(room.id.clone()),
            _ => None,
        };
        if let Some(request_id) = card.request_id.clone().filter(|id| !id.is_empty()) {
            if card.tool.is_some() {
                return CardAction::Nothing;
            }
            self.picked.insert(message_id.to_owned(), answer.to_owned());
            self.responding.insert(request_id.clone(), Responding { message_id: message_id.to_owned(), thread_id: thread_id.clone(), shown: Some(answer.to_owned()), closing: false, state: Answered::Pending });
            return CardAction::Respond(Respond { key: request_id.clone(), thread_id, body: cards::answer_body(&request_id, answer), body_without_grant: None, grant: None });
        }
        let Some((bot_id, _)) = owner else { return CardAction::Nothing };
        let reference = CardRef { bot_id: bot_id.clone(), message_id: message_id.to_owned(), group_id: room.clone() };
        let target = match room {
            Some(group_id) => Target::Group { group_id },
            None => Target::Bot { bot_id, deliver: None },
        };
        match self.queue(target, &thread_id, answer, now_ms, Some(reference)) {
            Some(item) => CardAction::Send(item),
            None => CardAction::Nothing,
        }
    }

    pub fn dismiss_card(&mut self, message_id: &str) -> CardAction {
        let Some((thread_id, message, card)) = self.find_card(message_id) else { return CardAction::Nothing };
        let request = card.request_id.clone().filter(|id| !id.is_empty());
        let body = request.as_ref().map(|request_id| cards::dismiss_body(request_id, card));
        let owner = self.owner_of(message).map(|(bot_id, _)| bot_id);
        let room = self.selected_room();
        if let (Some(request_id), Some(body)) = (request, body) {
            if self.question_busy(&request_id) {
                return CardAction::Nothing;
            }
            self.responding.insert(request_id.clone(), Responding { message_id: message_id.to_owned(), thread_id: thread_id.clone(), shown: None, closing: true, state: Answered::Pending });
            return CardAction::Respond(Respond { key: request_id, thread_id, body, body_without_grant: None, grant: None });
        }
        if let Some(message) = self.threads.get_mut(&thread_id).and_then(|messages| messages.iter_mut().find(|message| message.id == message_id)) {
            if let Some(wire) = message.card.as_mut() {
                wire.dismissed = true;
            }
        }
        match (room, owner) {
            (false, Some(bot_id)) => CardAction::Patch(CardPatch { path: format!("/api/bots/{bot_id}/cards/{message_id}"), body: serde_json::json!({ "dismissed": true }) }),
            _ => CardAction::Nothing,
        }
    }

    fn questions_of(&self, message_id: &str) -> Option<(String, Vec<crate::wire::WireQuestion>, String)> {
        let (thread_id, _, card) = self.find_card(message_id)?;
        if cards::kind(card) != CardKind::Question || card.answered.is_some() || card.dismissed {
            return None;
        }
        let questions = card.question_request.as_ref()?.questions.clone();
        (!questions.is_empty()).then(|| (thread_id, questions, card.request_id.clone().unwrap_or_default()))
    }

    fn question_busy(&self, request_id: &str) -> bool {
        self.responding.get(request_id).is_some_and(|responding| !matches!(responding.state, Answered::Failed(_)))
    }

    pub fn question(&mut self, message_id: &str, step: QuestionStep, now_ms: u64) -> CardAction {
        let _ = now_ms;
        let Some((thread_id, questions, request_id)) = self.questions_of(message_id) else { return CardAction::Nothing };
        if self.question_busy(&request_id) {
            return CardAction::Nothing;
        }
        let draft = self.drafts.entry(message_id.to_owned()).or_insert_with(|| QuestionDraft::new(questions.len()));
        let answer = match step {
            QuestionStep::Choose(index) => {
                let current = draft.active.min(questions.len() - 1);
                let Some(option) = questions[current].options.get(index) else { return CardAction::Nothing };
                match draft.choose(&questions, &option.label.clone()) {
                    cards::Choice::Submit(answer) => Some(answer),
                    cards::Choice::Stay => None,
                }
            }
            QuestionStep::Other => {
                draft.toggle_other(&questions);
                None
            }
            QuestionStep::Type(text) => {
                draft.type_other(&questions, &text);
                None
            }
            QuestionStep::Go(index) => {
                draft.go(&questions, index);
                None
            }
            QuestionStep::Back => {
                draft.step(&questions, -1);
                None
            }
            QuestionStep::Next => {
                if draft.answered().get(draft.active).copied().unwrap_or(false) {
                    draft.step(&questions, 1);
                }
                None
            }
            QuestionStep::Enter => match draft.enter(&questions) {
                Some(0) => draft.submit(&questions),
                Some(offset) => {
                    draft.step(&questions, offset);
                    None
                }
                None => None,
            },
            QuestionStep::Submit => draft.submit(&questions),
        };
        let Some(answer) = answer.filter(|answer| !answer.is_empty()) else { return CardAction::Nothing };
        self.responding.insert(request_id.clone(), Responding { message_id: message_id.to_owned(), thread_id: thread_id.clone(), shown: Some(answer.clone()), closing: false, state: Answered::Pending });
        CardAction::Respond(Respond { key: request_id.clone(), thread_id, body: cards::answer_body(&request_id, &answer), body_without_grant: None, grant: None })
    }

    pub fn decide(&mut self, message_id: &str, index: usize) -> CardAction {
        let Some((thread_id, message, card)) = self.find_card(message_id) else { return CardAction::Nothing };
        if !cards::pending_approval(card) {
            return CardAction::Nothing;
        }
        let request_id = card.request_id.clone().unwrap_or_default();
        if self.question_busy(&request_id) {
            return CardAction::Nothing;
        }
        let owner = self.owner_of(message);
        let decisions = cards::decisions(card, owner.is_some());
        let Some(decision) = decisions.get(index).filter(|decision| decision.enabled).cloned() else { return CardAction::Nothing };
        let allow_key = card.allow_key.clone().filter(|key| !key.is_empty());
        let grant = match (&owner, &allow_key) {
            (Some((bot_id, _)), Some(key)) if decision.always => Some(if key == cards::MAC_ALLOW_KEY {
                Grant { path: format!("/api/bots/{bot_id}/always-allow"), method: "POST", body: serde_json::json!({ "threadId": thread_id, "allowKey": key }) }
            } else {
                let mut next = self.dogs.iter().find(|dog| &dog.id == bot_id).map(|dog| dog.always_allow.clone()).unwrap_or_default();
                if !next.contains(key) {
                    next.push(key.clone());
                }
                Grant { path: format!("/api/bots/{bot_id}"), method: "PATCH", body: serde_json::json!({ "alwaysAllow": next }) }
            }),
            _ => None,
        };
        let body = cards::respond_body(&request_id, &decision, card, true);
        let body_without_grant = grant.as_ref().map(|_| cards::respond_body(&request_id, &decision, card, false));
        self.responding.insert(request_id.clone(), Responding { message_id: message_id.to_owned(), thread_id: thread_id.clone(), shown: None, closing: false, state: Answered::Pending });
        CardAction::Respond(Respond { key: request_id, thread_id, body, body_without_grant, grant })
    }

    pub fn responded(&mut self, key: &str, result: Result<(), RespondFailure>) -> Changes {
        let Some(responding) = self.responding.get_mut(key) else { return Changes::default() };
        match result {
            Ok(()) => responding.state = Answered::Sent,
            Err(failure) => {
                responding.state = Answered::Failed(cards::plain_error(&failure));
                responding.closing = false;
                responding.shown = None;
                let message_id = responding.message_id.clone();
                self.picked.remove(&message_id);
            }
        }
        let thread = self.responding.get(key).map(|responding| responding.thread_id.clone());
        Changes { sidebar: false, transcript: thread.as_deref() == self.selected_thread() }
    }

    pub fn answering(&self, request_id: &str) -> Option<&Answered> {
        self.responding.get(request_id).map(|responding| &responding.state)
    }

    fn card_pending(&self, message_id: &str) -> bool {
        self.pending_answer(message_id).is_some()
    }

    fn pending_answer(&self, message_id: &str) -> Option<&LocalSend> {
        self.sends.iter().find(|send| send.item.card.as_ref().is_some_and(|card| card.message_id == message_id) && matches!(send.state, SendState::Sending | SendState::Held))
    }

    pub fn view(&self) -> View {
        let chat = self.chat();
        let (dog, room) = match chat {
            Some(Chat::Dog(dog)) => (Some(dog), None),
            Some(Chat::Room(room)) => (None, Some(room)),
            None => (None, None),
        };
        let transcript = match chat {
            Some(chat) => self.transcript(chat),
            None => Vec::new(),
        };
        View {
            connection: self.connection,
            status: self.connection.words(),
            selected: self.selected.clone().filter(|_| chat.is_some()),
            title: dog.map(|dog| dog.name.clone()).or_else(|| room.map(|room| room.name.clone())).unwrap_or_default(),
            color: dog.map(Dog::color).unwrap_or_else(|| DEFAULT_COLOR.to_owned()),
            body: crate::mascot::body(dog.and_then(|dog| dog.body.as_deref())).to_owned(),
            model: dog.and_then(|dog| dog.model.clone()),
            work: dog.and_then(|dog| dog.work.clone()).or_else(|| room.and_then(|room| room.work.clone())),
            room: room.is_some(),
            dogs: self
                .sidebar_order()
                .into_iter()
                .map(|dog| {
                    let last = self.last_words(&dog.thread_id);
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
            rooms: self.room_order().into_iter().map(|room| self.room_row(room)).collect(),
            sidebar: self.sidebar_entries(),
            approval: chat.and_then(|chat| self.approval_panel(chat)),
            transcript,
        }
    }

    fn face_of(&self, bot_id: &str, fallback_name: &str, fallback_color: &str) -> Face {
        let dog = self.dogs.iter().find(|dog| dog.id == bot_id);
        Face {
            name: dog.map(|dog| dog.name.clone()).filter(|name| !name.is_empty()).unwrap_or_else(|| fallback_name.to_owned()),
            color: dog.map(Dog::color).unwrap_or_else(|| if fallback_color.is_empty() { DEFAULT_COLOR.to_owned() } else { fallback_color.to_owned() }),
            body: crate::mascot::body(dog.and_then(|dog| dog.body.as_deref())).to_owned(),
        }
    }

    fn room_row(&self, room: &Room) -> RoomRow {
        let members: Vec<&Dog> = room.member_ids.iter().filter_map(|id| self.dogs.iter().find(|dog| &dog.id == id)).collect();
        let faces: Vec<Face> = members.iter().take(if members.len() <= 1 { 1 } else { 2 }).map(|dog| self.face_of(&dog.id, &dog.name, "")).collect();
        let last = self.last_words(&room.thread_id);
        let preview = if let Some(busy) = &room.busy_bot_id {
            let name = self.dogs.iter().find(|dog| &dog.id == busy).map(|dog| dog.name.clone()).unwrap_or_else(|| ROOM_A_BOT.to_owned());
            crate::words::fill(ROOM_BOT_WORKING, &[("name", &name)])
        } else if room.working {
            ROOM_TEAM_WORKING.to_owned()
        } else {
            match last {
                None => ROOM_NO_MESSAGES.to_owned(),
                Some(message) if message.is_from_person() => crate::words::fill(ROOM_YOU, &[("text", &preview_of(message))]),
                Some(message) => match &message.from {
                    Some(from) => format!("{}: {}", self.face_of(&from.bot_id, &from.name, "").name, preview_of(message)),
                    None => preview_of(message),
                },
            }
        };
        RoomRow {
            id: room.id.clone(),
            name: room.name.clone(),
            unread: room.unread,
            selected: Some(&room.id) == self.selected.as_ref(),
            extra: members.len().saturating_sub(faces.len()),
            faces,
            preview,
            last_at: last.map(|message| message.at),
        }
    }

    fn section_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = Vec::new();
        for name in self.sections.iter().map(String::as_str) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        let sectioned = self.dogs.iter().filter(|dog| !dog.hidden && !dog.pinned).filter_map(|dog| dog.section.as_deref());
        let rooms = self.rooms.iter().filter(|room| !room.dm).filter_map(|room| room.section.as_deref());
        for section in rooms.chain(sectioned) {
            if !names.contains(&section) {
                names.push(section);
            }
        }
        names
    }

    fn room_order(&self) -> Vec<&Room> {
        let shown: Vec<&Room> = self.rooms.iter().filter(|room| !room.dm).collect();
        let names = self.section_names();
        let sectioned = names.into_iter().flat_map(|name| shown.iter().copied().filter(move |room| room.section.as_deref() == Some(name)));
        sectioned.chain(shown.iter().copied().filter(|room| room.section.is_none())).collect()
    }

    fn sidebar_entries(&self) -> Vec<SidebarEntry> {
        let order = self.sidebar_order();
        let rooms = self.room_order();
        let names = self.section_names();
        let mut entries = Vec::with_capacity(order.len() + rooms.len() + names.len() + 1);
        let pinned = order.iter().take_while(|dog| dog.pinned).count();
        entries.extend((0..pinned).map(|index| SidebarEntry::Dog { index }));
        if names.is_empty() {
            entries.extend((0..rooms.len()).map(|index| SidebarEntry::Room { index }));
            entries.extend((pinned..order.len()).map(|index| SidebarEntry::Dog { index }));
            return entries;
        }
        let mut groups: Vec<(String, Vec<SidebarEntry>)> = names.iter().map(|name| ((*name).to_owned(), Vec::new())).collect();
        let mut rest = Vec::new();
        for (index, room) in rooms.iter().enumerate() {
            match room.section.as_deref().and_then(|section| groups.iter().position(|(name, _)| name == section)) {
                Some(group) => groups[group].1.push(SidebarEntry::Room { index }),
                None => rest.push(SidebarEntry::Room { index }),
            }
        }
        for (index, dog) in order.iter().enumerate().skip(pinned) {
            match dog.section.as_deref().and_then(|section| groups.iter().position(|(name, _)| name == section)) {
                Some(group) => groups[group].1.push(SidebarEntry::Dog { index }),
                None => rest.push(SidebarEntry::Dog { index }),
            }
        }
        groups.push((crate::words::SECTION_UNASSIGNED.to_owned(), rest));
        for (position, (name, members)) in groups.into_iter().enumerate() {
            entries.push(SidebarEntry::Header { name, count: members.len(), first: position == 0 });
            entries.extend(members);
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

    fn last_words(&self, thread_id: &str) -> Option<&WireMessage> {
        self.thread(thread_id)
            .iter()
            .rev()
            .find(|message| !matches!(message.kind.as_str(), "activity" | "digest" | "compaction" | "options") && message.text.as_deref().is_some_and(|text| !text.trim().is_empty()))
    }

    fn approval_panel(&self, chat: Chat<'_>) -> Option<ApprovalPanel> {
        let messages = self.thread(chat.thread_id());
        let pending: Vec<&WireMessage> = messages.iter().filter(|message| message.kind == "options" && message.card.as_ref().is_some_and(cards::pending_approval)).collect();
        let message = *pending.first()?;
        let card = message.card.as_ref()?;
        let owner = self.owner_of_in(chat, message);
        let name = owner.as_ref().map(|(_, name)| name.as_str());
        let request_id = card.request_id.clone().unwrap_or_default();
        let state = self.responding.get(&request_id).map(|responding| &responding.state);
        let command = card.command_allowlist.as_ref().and_then(|allow| allow.get("command")).and_then(|command| command.as_str()).map(str::to_owned);
        let reviewed = cards::is_proposal(card);
        let outbound = card.outbound_request.is_some();
        Some(ApprovalPanel {
            message_id: message.id.clone(),
            request_id,
            label: cards::panel_label(card, name),
            position: (pending.len() > 1).then(|| crate::words::fill(cards::APPROVAL_POSITION, &[("index", "1"), ("count", &pending.len().to_string())])),
            detail: command.unwrap_or_else(|| card.subtitle.clone()),
            reviewed,
            held: card.held.clone().filter(|held| !held.is_empty() && !(outbound && card.allow_key.is_some())),
            decisions: cards::decisions(card, owner.is_some()),
            reach: cards::reach(card, name),
            sending: matches!(state, Some(Answered::Pending | Answered::Sent)),
            error: match state {
                Some(Answered::Failed(words)) => Some(words.clone()),
                _ => None,
            },
        })
    }

    fn owner_of_in(&self, chat: Chat<'_>, message: &WireMessage) -> Option<(String, String)> {
        match chat {
            Chat::Dog(dog) => Some((dog.id.clone(), dog.name.clone())),
            Chat::Room(_) => {
                let from = message.from.as_ref()?;
                Some((from.bot_id.clone(), self.face_of(&from.bot_id, &from.name, "").name))
            }
        }
    }

    fn card_line(&self, chat: Chat<'_>, messages: &[WireMessage], index: usize) -> Option<CardLine> {
        let message = &messages[index];
        let card = message.card.as_ref()?;
        let owner = self.owner_of_in(chat, message);
        let name = owner.as_ref().map(|(_, name)| name.clone());
        let room = matches!(chat, Chat::Room(_));
        match cards::kind(card) {
            CardKind::Other => None,
            CardKind::Approval => self.approval_line(card, name.as_deref()),
            CardKind::Question => self.question_line(message, card, name.as_deref()),
            CardKind::Options => {
                let onboarding = cards::is_onboarding(card);
                let pending = self.pending_answer(&message.id).map(|send| send.item.text.clone());
                if onboarding {
                    if card.dismissed || card.answered.is_some() {
                        return None;
                    }
                    if !room && self.later_person_line(chat.thread_id(), messages, index) {
                        return None;
                    }
                } else if card.dismissed && card.answered.is_some() {
                    return None;
                }
                let request = card.request_id.clone().unwrap_or_default();
                let state = self.responding.get(&request).filter(|_| !request.is_empty());
                let picked = self.picked.get(&message.id).cloned().or(pending.clone());
                let answered = card.answered.is_some() || picked.is_some();
                if !answered {
                    if state.is_some_and(|state| state.closing && !matches!(state.state, Answered::Failed(_))) {
                        return None;
                    }
                    return Some(CardLine::Options {
                        message_id: message.id.clone(),
                        title: cards::option_title(card, name.as_deref()),
                        subtitle: card.subtitle.clone(),
                        choices: cards::option_choices(card),
                        custom: card.tool.is_none(),
                        dismiss: cards::can_dismiss_option(card),
                        error: match state.map(|state| &state.state) {
                            Some(Answered::Failed(words)) => Some(words.clone()),
                            _ => None,
                        },
                    });
                }
                let chosen = cards::chosen_answer(card, picked.as_deref());
                let sending = pending.is_some() && card.answered.is_none();
                let line = chosen.unwrap_or_else(|| cards::QUESTION_ANSWERED.to_owned());
                Some(CardLine::Folded {
                    icon: if sending { FoldIcon::Sending } else { FoldIcon::Check },
                    summary: if sending { format!("{} {line}", cards::SENDING) } else { line.clone() },
                    trailing: None,
                    label: if sending { format!("{} {line}", cards::SENDING) } else { crate::words::fill(cards::QUESTION_ANSWERED_LABEL, &[("answer", &line)]) },
                    centered: false,
                })
            }
        }
    }

    fn later_person_line(&self, thread_id: &str, messages: &[WireMessage], index: usize) -> bool {
        let at = messages[index].at;
        messages[index + 1..].iter().any(|later| later.role == "user" && later.kind == "text")
            || self.sends.iter().any(|send| {
                send.item.thread_id == thread_id
                    && send.item.queued_at >= at
                    && matches!(send.state, SendState::Sending | SendState::Held)
                    && !messages.iter().any(|message| message.send_id.as_deref() == Some(send.item.send_id.as_str()))
            })
    }

    fn approval_line(&self, card: &WireCard, name: Option<&str>) -> Option<CardLine> {
        if let Some(folded) = cards::approval_folded(card) {
            let mut trailing = Vec::new();
            if let Some(action) = &folded.action {
                trailing.push(action.clone());
            }
            if folded.external {
                if let Some(label) = &card.native_actor_label {
                    trailing.push(crate::words::fill(cards::REQUESTED_BY, &[("label", label)]));
                }
            }
            if folded.by_voice {
                trailing.push(cards::APPROVAL_BY_VOICE.to_owned());
            }
            let title = match &folded.action {
                Some(action) => format!("{} \u{b7} {action}", folded.outcome),
                None => folded.outcome.clone(),
            };
            return Some(CardLine::Folded {
                icon: if folded.external { FoldIcon::Minus } else if folded.allowed { FoldIcon::Check } else { FoldIcon::Cross },
                summary: folded.outcome.clone(),
                trailing: (!trailing.is_empty()).then(|| trailing.join(" \u{b7} ")),
                label: title,
                centered: folded.action.is_some(),
            });
        }
        let action = cards::approval_action(card);
        let line = match name {
            Some(name) => crate::words::fill(cards::APPROVAL_NAMED_WANTS_TO, &[("name", name), ("action", &action)]),
            None => crate::words::fill(cards::APPROVAL_WANTS_TO, &[("action", &action)]),
        };
        let durable = card.routine_request.is_some() || card.skill_request.is_some() || card.profile_request.is_some();
        Some(CardLine::Waiting { line, note: if durable { cards::APPROVAL_WAITING_CONFIRMATION } else { cards::APPROVAL_WAITING_ANSWER } })
    }

    fn question_line(&self, message: &WireMessage, card: &WireCard, name: Option<&str>) -> Option<CardLine> {
        let questions = &card.question_request.as_ref()?.questions;
        if questions.is_empty() || card.dismissed {
            return None;
        }
        let request = card.request_id.clone().unwrap_or_default();
        let responding = self.responding.get(&request);
        if responding.is_some_and(|responding| responding.closing && !matches!(responding.state, Answered::Failed(_))) {
            return None;
        }
        let sent = responding.filter(|responding| !matches!(responding.state, Answered::Failed(_))).and_then(|responding| responding.shown.clone());
        let external = card.answered.as_deref() == Some("resolved");
        if card.answered.is_some() || sent.is_some() {
            let answer = card.answered_text.clone().or_else(|| external.then(|| cards::RESOLVED_EXTERNALLY.to_owned())).or(sent);
            let line = if external { answer.clone().unwrap_or_default() } else { answer.as_deref().map(|answer| cards::answer_summary(answer, questions)).unwrap_or_else(|| cards::QUESTION_ANSWERED.to_owned()) };
            let trailing = external.then(|| card.native_actor_label.as_ref().map(|label| crate::words::fill(cards::REQUESTED_BY, &[("label", label)]))).flatten();
            return Some(CardLine::Folded {
                icon: if external { FoldIcon::Minus } else { FoldIcon::Check },
                label: if external { line.clone() } else { crate::words::fill(cards::QUESTION_ANSWERED_LABEL, &[("answer", &line)]) },
                summary: line,
                trailing,
                centered: false,
            });
        }
        let draft = self.drafts.get(&message.id).cloned().unwrap_or_else(|| QuestionDraft::new(questions.len()));
        let current = draft.active.min(questions.len() - 1);
        let question = &questions[current];
        let empty = cards::Draft::default();
        let now = draft.drafts.get(current).unwrap_or(&empty);
        let answered = draft.answered();
        let complete = draft.complete(questions);
        let many = questions.len() > 1;
        let letter = |index: usize| cards::QUESTION_LETTERS.chars().nth(index % 26).map(String::from).unwrap_or_default();
        let footer = if many {
            let last = current + 1 == questions.len();
            QuestionFooter::Steps {
                back: current > 0,
                next: if last { cards::QUESTION_SUBMIT_ALL } else { cards::QUESTION_NEXT },
                next_enabled: if last { complete } else { answered.get(current).copied().unwrap_or(false) },
                last,
            }
        } else if question.multi_select || now.other {
            QuestionFooter::Submit { enabled: complete }
        } else {
            QuestionFooter::None
        };
        Some(CardLine::Question {
            message_id: message.id.clone(),
            title: match name {
                Some(name) => crate::words::fill(cards::QUESTION_NAMED, &[("name", name)]),
                None => cards::QUESTION_TITLE.to_owned(),
            },
            actor: card.native_actor_label.as_ref().map(|label| crate::words::fill(cards::REQUESTED_BY, &[("label", label)])),
            origin: card.question_request.as_ref().and_then(|request| request.origin.as_deref()) == Some("output"),
            step: many.then(|| crate::words::fill(cards::QUESTION_STEP, &[("current", &(current + 1).to_string()), ("count", &questions.len().to_string())])),
            tabs: if many {
                questions
                    .iter()
                    .enumerate()
                    .map(|(index, question)| QuestionTab {
                        label: question.header.clone().unwrap_or_else(|| crate::words::fill(cards::QUESTION_TAB, &[("index", &(index + 1).to_string())])),
                        current: index == current,
                        answered: answered.get(index).copied().unwrap_or(false),
                    })
                    .collect()
            } else {
                Vec::new()
            },
            question: question.question.clone(),
            multi: question.multi_select,
            options: question
                .options
                .iter()
                .enumerate()
                .map(|(index, option)| QuestionOption { letter: letter(index), label: option.label.clone(), description: option.description.clone(), picked: now.picked.contains(&option.label) })
                .collect(),
            other_letter: letter(question.options.len()),
            other: now.other,
            custom: now.custom.clone(),
            footer,
            error: match responding.map(|responding| &responding.state) {
                Some(Answered::Failed(words)) => Some(words.clone()),
                _ => None,
            },
        })
    }

    fn transcript(&self, chat: Chat<'_>) -> Vec<TranscriptRow> {
        let thread_id = chat.thread_id();
        let messages = self.thread(thread_id);
        let (who_default, room) = match chat {
            Chat::Dog(dog) => (dog.name.clone(), false),
            Chat::Room(_) => (String::new(), true),
        };
        let mut rows: Vec<TranscriptRow> = Vec::new();
        let mut folded: Vec<&str> = Vec::new();
        let mut previous: Option<&WireMessage> = None;
        for (index, message) in messages.iter().enumerate() {
            if folded.contains(&message.id.as_str()) {
                continue;
            }
            let face = if room && !message.is_from_person() {
                let cluster = match previous {
                    None => true,
                    Some(before) => before.role != message.role || before.from.as_ref().map(|from| &from.bot_id) != message.from.as_ref().map(|from| &from.bot_id) || before.comm.is_some(),
                };
                message.from.as_ref().filter(|_| cluster && !(message.kind == "activity" && message.comm.is_some())).map(|from| self.face_of(&from.bot_id, &from.name, &from.color))
            } else {
                None
            };
            previous = Some(message);
            let who = match (&message.from, room) {
                (Some(from), true) => self.face_of(&from.bot_id, &from.name, &from.color).name,
                _ => who_default.clone(),
            };
            let start = rows.len();
            match message.kind.as_str() {
                "digest" | "compaction" => {}
                "options" => {
                    if let Some(card) = self.card_line(chat, messages, index) {
                        let mut row = TranscriptRow::quiet(&message.id, RowKind::Card, &who, String::new(), message.at);
                        row.card = Some(card);
                        rows.push(row);
                    }
                }
                "activity" => {
                    let Some(tool) = message.tool.as_ref() else { continue };
                    if let Some((line, used)) = self.exchange_line(message, messages.get(index + 1)) {
                        if let Some(used) = used {
                            folded.push(used);
                        }
                        let mut row = TranscriptRow::quiet(&message.id, RowKind::Exchange, &who, line.spoken(), message.at);
                        row.exchange = Some(line);
                        rows.push(row);
                        continue;
                    }
                    let line = tool.spoken.clone().or_else(|| tool.summary.clone()).unwrap_or_else(|| tool.name.clone());
                    match rows.last_mut() {
                        Some(row) if row.kind == RowKind::Work => {
                            row.text = line;
                            row.at = message.at;
                        }
                        _ => rows.push(TranscriptRow::quiet(&message.id, RowKind::Work, &who, line, message.at)),
                    }
                }
                _ => rows.extend(self.row(&who, message)),
            }
            if let Some(row) = rows.get_mut(start) {
                row.face = face;
                row.room = room;
            }
        }
        for send in &self.sends {
            let landed = messages.iter().any(|message| message.send_id.as_deref() == Some(send.item.send_id.as_str()));
            if send.item.thread_id == thread_id && !landed {
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
                    face: None,
                    card: None,
                    ran: None,
                    room,
                });
            }
        }
        rows
    }

    fn row(&self, who: &str, message: &WireMessage) -> Option<TranscriptRow> {
        let mine = message.is_from_person();
        let text = message.text.clone().unwrap_or_default();
        if text.trim().is_empty() {
            return None;
        }
        let status = message.send_id.as_deref().and_then(|send_id| self.send_state(send_id)).map(SendState::words);
        Some(TranscriptRow {
            id: message.id.clone(),
            kind: RowKind::Text,
            who: if mine { "You".to_owned() } else { who.to_owned() },
            mine,
            text,
            quiet: false,
            at: message.at,
            status,
            send_id: message.send_id.clone(),
            exchange: None,
            face: None,
            card: None,
            ran: if mine { None } else { crate::receipt::ran_block(message.ran.as_ref(), message.results.as_ref()) },
            room: false,
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
        let present = self.selected.as_ref().is_some_and(|selected| {
            self.dogs.iter().any(|dog| &dog.id == selected && !dog.hidden) || self.rooms.iter().any(|room| &room.id == selected && !room.dm)
        });
        if !present {
            self.selected = self.sidebar_order().first().map(|dog| dog.id.clone());
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuestionStep {
    Choose(usize),
    Other,
    Type(String),
    Go(usize),
    Back,
    Next,
    Enter,
    Submit,
}
