use serde::{Deserialize, Serialize};

use crate::words::{self, fill};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Owner {
    pub dog: String,
    pub person: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireExchange {
    pub id: String,
    pub status: String,
    pub owner: Owner,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub to: String,
    pub request: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_by: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub waiting_on: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireComm {
    pub with_bot_id: String,
    pub with_name: String,
    pub with_color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RoomRequest {
    pub id: String,
    pub phase: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub heading: String,
    pub request: String,
    pub reply: Option<String>,
    pub waiting: Option<String>,
    pub ended: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeLine {
    pub label: &'static str,
    pub dog_id: String,
    pub name: String,
    pub color: String,
    pub body: String,
    pub gist: Option<String>,
    pub state: &'static str,
    pub details: Details,
}

impl ExchangeLine {
    pub fn spoken(&self) -> String {
        let mut said = format!("{} {}", self.label, self.name);
        if let Some(gist) = &self.gist {
            said.push_str(&format!(": {gist}"));
        }
        format!("{said} \u{b7} {}", self.state)
    }

    pub fn needs_you(&self) -> bool {
        self.state == words::EXCHANGE_STATE_NEEDS_YOU
    }
}

pub fn gist(request: &str) -> Option<String> {
    let mut rest = request.trim_start();
    while rest.starts_with('@') {
        match rest.find(char::is_whitespace) {
            Some(end) => rest = rest[end..].trim_start(),
            None => {
                rest = "";
                break;
            }
        }
    }
    let line = rest.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() > 90 {
        let short: String = line.chars().take(89).collect();
        return Some(format!("{short}\u{2026}"));
    }
    Some(line)
}

pub fn state(record: &WireExchange) -> &'static str {
    match record.status.as_str() {
        "completed" if record.reply.as_deref().is_none_or(|reply| reply.trim().is_empty()) => words::EXCHANGE_STATE_WORKING,
        "completed" => words::EXCHANGE_STATE_DONE,
        "queued" => words::EXCHANGE_STATE_QUEUED,
        "needs-you" => words::EXCHANGE_STATE_NEEDS_YOU,
        "failed" => words::EXCHANGE_STATE_FAILED,
        "cancelled" => words::EXCHANGE_STATE_STOPPED,
        _ => words::EXCHANGE_STATE_WORKING,
    }
}

pub fn details(record: &WireExchange) -> Details {
    let who = match &record.from {
        Some(from) => fill(words::EXCHANGE_ASKED, &[("from", from), ("to", &record.to)]),
        None => record.to.clone(),
    };
    let owner = fill(if record.owner.person { words::EXCHANGE_OWNER_PERSON } else { words::EXCHANGE_OWNER_DOG }, &[("dog", &record.owner.dog)]);
    let ended = match record.ended_by.as_deref() {
        Some("person") => Some(words::EXCHANGE_ENDED_PERSON),
        Some("restart") => Some(words::EXCHANGE_ENDED_RESTART),
        Some("idle" | "timeout" | "ceiling" | "capped") => Some(words::EXCHANGE_ENDED_TIME),
        Some("limit") => Some(words::EXCHANGE_ENDED_LIMIT),
        _ => None,
    };
    Details {
        heading: format!("{who} \u{b7} {owner}"),
        request: record.request.clone(),
        reply: record.reply.clone().filter(|reply| !reply.is_empty()),
        waiting: (!record.waiting_on.is_empty()).then(|| fill(words::EXCHANGE_WAITING_ON, &[("names", &record.waiting_on.join(", "))])),
        ended: ended.map(str::to_owned),
    }
}

pub fn label(direction: Option<&str>, tool_name: &str) -> Option<&'static str> {
    match direction {
        Some("to") => Some(words::EXCHANGE_MESSAGED),
        Some("from") => Some(words::EXCHANGE_MESSAGE_FROM),
        _ if tool_name.starts_with("Messaged @") || tool_name.starts_with("Sent to ") => Some(words::EXCHANGE_MESSAGED),
        _ if tool_name.starts_with("Message from @") => Some(words::EXCHANGE_MESSAGE_FROM),
        _ => None,
    }
}
