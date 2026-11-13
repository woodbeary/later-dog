use serde::{Deserialize, Serialize};

use crate::words::{self, fill};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkDog {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Work {
    Running { dogs: Vec<WorkDog> },
    WaitingOnDog { dogs: Vec<WorkDog> },
    NeedsYou { what: Option<String> },
    WaitingForUsage { account: Option<String>, until: Option<u64> },
    WaitingForComputer { holder: Option<String> },
    Retrying { attempt: Option<u64> },
    Stopped { by_you: bool, detail: Option<String> },
    Idle,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Raw {
    kind: String,
    dogs: serde_json::Value,
    what: serde_json::Value,
    account: serde_json::Value,
    until: serde_json::Value,
    holder: serde_json::Value,
    attempt: serde_json::Value,
    cause: serde_json::Value,
    detail: serde_json::Value,
}

fn words(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn number(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64))
}

fn dogs(value: &serde_json::Value) -> Vec<WorkDog> {
    value.as_array().map(|items| items.iter().filter_map(|item| WorkDog::deserialize(item).ok()).collect()).unwrap_or_default()
}

impl Work {
    pub fn from_value(value: &serde_json::Value) -> Option<Work> {
        let raw = Raw::deserialize(value).ok()?;
        Some(match raw.kind.as_str() {
            "running" => Work::Running { dogs: dogs(&raw.dogs) },
            "waiting-on-dog" => Work::WaitingOnDog { dogs: dogs(&raw.dogs) },
            "needs-you" => Work::NeedsYou { what: words(&raw.what) },
            "waiting-for-usage" => Work::WaitingForUsage { account: words(&raw.account), until: number(&raw.until) },
            "waiting-for-computer" => Work::WaitingForComputer { holder: words(&raw.holder) },
            "retrying" => Work::Retrying { attempt: number(&raw.attempt) },
            "stopped" => Work::Stopped { by_you: raw.cause.as_str() == Some("you"), detail: words(&raw.detail) },
            "idle" => Work::Idle,
            _ => return None,
        })
    }
}

fn names(dogs: &[WorkDog]) -> Option<String> {
    words::list(&dogs.iter().map(|dog| dog.name.as_str()).collect::<Vec<_>>())
}

pub fn line(work: Option<&Work>, now: u64, reset_time: &dyn Fn(u64, u64) -> String) -> Option<String> {
    Some(match work? {
        Work::NeedsYou { what: Some(what) } => fill(words::WORK_NEEDS_YOU_WHAT, &[("what", what)]),
        Work::NeedsYou { what: None } => words::WORK_NEEDS_YOU.to_owned(),
        Work::WaitingForUsage { account, until } => {
            let time = until.filter(|until| *until > now).map(|until| reset_time(until, now));
            match (account, time) {
                (Some(account), Some(time)) => fill(words::WORK_USAGE_ON_UNTIL, &[("account", account), ("time", &time)]),
                (None, Some(time)) => fill(words::WORK_USAGE_UNTIL, &[("time", &time)]),
                (Some(account), None) => fill(words::WORK_USAGE_ON, &[("account", account)]),
                (None, None) => words::WORK_USAGE.to_owned(),
            }
        }
        Work::Running { dogs } => {
            let names = names(dogs)?;
            fill(if dogs.len() > 1 { words::WORK_ROOM_WORKING_MANY } else { words::WORK_ROOM_WORKING_ONE }, &[("names", &names)])
        }
        Work::WaitingOnDog { dogs } => fill(words::CHAT_WAITING_ON, &[("names", &names(dogs)?)]),
        Work::WaitingForComputer { holder: Some(holder) } => fill(words::WORK_COMPUTER_HELD, &[("name", holder)]),
        Work::WaitingForComputer { holder: None } => words::WORK_COMPUTER.to_owned(),
        Work::Retrying { attempt: Some(attempt) } if *attempt > 0 => fill(words::WORK_RETRYING_TRY, &[("attempt", &attempt.to_string())]),
        Work::Retrying { .. } => words::WORK_RETRYING.to_owned(),
        Work::Stopped { by_you: true, .. } => words::WORK_STOPPED_BY_YOU.to_owned(),
        Work::Stopped { detail, .. } => match detail.as_deref() {
            Some("stalled") => words::WORK_STOPPED_STALLED.to_owned(),
            Some("closed") => words::WORK_STOPPED_CLOSED.to_owned(),
            _ => words::WORK_STOPPED_ENGINE.to_owned(),
        },
        Work::Idle => return None,
    })
}

pub fn sidebar_line(work: Option<&Work>, now: u64, reset_time: &dyn Fn(u64, u64) -> String) -> Option<String> {
    match work? {
        Work::NeedsYou { .. } | Work::Stopped { by_you: true, .. } => None,
        other => line(Some(other), now, reset_time),
    }
}
