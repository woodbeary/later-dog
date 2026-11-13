use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const OUTBOX_VERSION: u64 = 1;
pub const MAX_SERVER_FAILURES: u32 = 5;
pub const HOLD_CAP_MS: u64 = 15_000;
pub const HOLD_BASE_MS: u64 = 2_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Target {
    Bot {
        bot_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deliver: Option<String>,
    },
    Group {
        group_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRef {
    pub bot_id: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub send_id: String,
    pub thread_id: String,
    pub target: Target,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
    pub queued_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<CardRef>,
}

impl Item {
    pub fn lane_key(&self) -> String {
        if !self.thread_id.is_empty() {
            return self.thread_id.clone();
        }
        match &self.target {
            Target::Bot { bot_id, .. } => format!("bot:{bot_id}"),
            Target::Group { group_id } => format!("group:{group_id}"),
        }
    }

    fn well_formed(&self) -> bool {
        let target = match &self.target {
            Target::Bot { bot_id, .. } => !bot_id.is_empty(),
            Target::Group { group_id } => !group_id.is_empty(),
        };
        target && !self.send_id.is_empty() && !self.thread_id.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    Network,
    Timeout,
    Waking { retry_after_ms: Option<u64> },
    Status { code: u16, retry_after_ms: Option<u64> },
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Hold { after_ms: Option<u64> },
    Retry,
    Final,
}

pub fn send_outcome(failure: &Failure) -> Outcome {
    let positive = |ms: &Option<u64>| ms.filter(|ms| *ms > 0);
    match failure {
        Failure::Network | Failure::Timeout => Outcome::Hold { after_ms: None },
        Failure::Waking { retry_after_ms } => Outcome::Hold { after_ms: positive(retry_after_ms) },
        Failure::Status { code, retry_after_ms } => match code {
            502 | 503 | 504 | 408 | 429 => Outcome::Hold { after_ms: positive(retry_after_ms) },
            code if *code >= 500 => Outcome::Retry,
            _ => Outcome::Final,
        },
        Failure::Unreadable => Outcome::Final,
    }
}

pub fn hold_delay(attempt: u32) -> u64 {
    let doublings = attempt.saturating_sub(1).min(16);
    HOLD_CAP_MS.min(HOLD_BASE_MS << doublings)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settled {
    Held { item: Item, until_ms: u64 },
    Final { item: Item },
    Gone,
}

#[derive(Default)]
struct Lane {
    items: VecDeque<Item>,
    in_flight: Option<String>,
    holds: u32,
    failures: u32,
    wake_at_ms: Option<u64>,
}

impl Lane {
    fn rest(&mut self) {
        self.holds = 0;
        self.failures = 0;
        self.wake_at_ms = None;
    }

    fn head_is(&self, send_id: &str) -> bool {
        self.items.front().is_some_and(|item| item.send_id == send_id)
    }

    fn spent(&self) -> bool {
        self.items.is_empty() && self.in_flight.is_none()
    }
}

#[derive(Default)]
pub struct Outbox {
    lanes: BTreeMap<String, Lane>,
}

impl Outbox {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn holds(&self, send_id: &str) -> bool {
        self.lanes.values().any(|lane| lane.items.iter().any(|item| item.send_id == send_id))
    }

    pub fn enqueue(&mut self, item: Item) -> bool {
        if self.holds(&item.send_id) {
            return false;
        }
        self.lanes.entry(item.lane_key()).or_default().items.push_back(item);
        true
    }

    pub fn restore(&mut self, items: impl IntoIterator<Item = Item>) {
        for item in items {
            self.enqueue(item);
        }
        for lane in self.lanes.values_mut() {
            lane.items.make_contiguous().sort_by_key(|item| item.queued_at);
        }
    }

    pub fn due(&mut self, now_ms: u64) -> Vec<Item> {
        let mut ready = Vec::new();
        for lane in self.lanes.values_mut() {
            let waiting = lane.wake_at_ms.is_some_and(|at| at > now_ms);
            if lane.in_flight.is_some() || waiting {
                continue;
            }
            if let Some(head) = lane.items.front() {
                lane.in_flight = Some(head.send_id.clone());
                lane.wake_at_ms = None;
                ready.push(head.clone());
            }
        }
        ready.sort_by_key(|item| item.queued_at);
        ready
    }

    pub fn next_wake_ms(&self) -> Option<u64> {
        self.lanes
            .values()
            .filter(|lane| lane.in_flight.is_none() && !lane.items.is_empty())
            .filter_map(|lane| lane.wake_at_ms)
            .min()
    }

    pub fn delivered(&mut self, send_id: &str) {
        self.land(send_id);
        self.remove(send_id);
    }

    pub fn acknowledge(&mut self, send_id: &str) -> bool {
        self.remove(send_id)
    }

    pub fn failed(&mut self, send_id: &str, failure: &Failure, now_ms: u64) -> Settled {
        let Some(key) = self.land(send_id) else {
            return Settled::Gone;
        };
        let Some(lane) = self.lanes.get_mut(&key) else {
            return Settled::Gone;
        };
        if !lane.head_is(send_id) {
            self.sweep(&key);
            return Settled::Gone;
        }
        let wait = match send_outcome(failure) {
            Outcome::Hold { after_ms } => {
                lane.holds += 1;
                Some(after_ms.unwrap_or_else(|| hold_delay(lane.holds)))
            }
            Outcome::Retry if lane.failures + 1 < MAX_SERVER_FAILURES => {
                lane.failures += 1;
                Some(hold_delay(lane.failures))
            }
            Outcome::Retry | Outcome::Final => None,
        };
        if let (Some(wait), Some(item)) = (wait, lane.items.front().cloned()) {
            let until_ms = now_ms.saturating_add(wait);
            lane.wake_at_ms = Some(until_ms);
            return Settled::Held { item, until_ms };
        }
        let item = lane.items.pop_front();
        lane.rest();
        self.sweep(&key);
        item.map_or(Settled::Gone, |item| Settled::Final { item })
    }

    pub fn items(&self) -> Vec<Item> {
        let mut all: Vec<Item> = self.lanes.values().flat_map(|lane| lane.items.iter().cloned()).collect();
        all.sort_by_key(|item| item.queued_at);
        all
    }

    pub fn saved(&self) -> Option<String> {
        let items = self.items();
        if items.is_empty() {
            return None;
        }
        serde_json::to_string(&serde_json::json!({ "version": OUTBOX_VERSION, "items": items })).ok()
    }

    fn land(&mut self, send_id: &str) -> Option<String> {
        let key = self
            .lanes
            .iter()
            .find(|(_, lane)| lane.in_flight.as_deref() == Some(send_id))
            .map(|(key, _)| key.clone())?;
        self.lanes.get_mut(&key)?.in_flight = None;
        Some(key)
    }

    fn remove(&mut self, send_id: &str) -> bool {
        let Some(key) = self
            .lanes
            .iter()
            .find(|(_, lane)| lane.items.iter().any(|item| item.send_id == send_id))
            .map(|(key, _)| key.clone())
        else {
            return false;
        };
        if let Some(lane) = self.lanes.get_mut(&key) {
            if lane.head_is(send_id) {
                lane.rest();
            }
            lane.items.retain(|item| item.send_id != send_id);
        }
        self.sweep(&key);
        true
    }

    fn sweep(&mut self, key: &str) {
        if self.lanes.get(key).is_some_and(Lane::spent) {
            self.lanes.remove(key);
        }
    }
}

pub fn parse_saved(raw: &str) -> Vec<Item> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    if value.get("version").and_then(Value::as_u64) != Some(OUTBOX_VERSION) {
        return Vec::new();
    }
    let Some(items) = value.get("items").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| serde_json::from_value::<Item>(item.clone()).ok())
        .filter(Item::well_formed)
        .collect()
}
