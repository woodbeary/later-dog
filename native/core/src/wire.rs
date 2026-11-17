use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(T::deserialize(value).unwrap_or_default())
}

fn lenient_list<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    let Value::Array(items) = value else {
        return Ok(Vec::new());
    };
    Ok(items.into_iter().filter_map(|item| T::deserialize(item).ok()).collect())
}

fn lenient_optional_list<'de, D, T>(deserializer: D) -> Result<Option<Vec<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    let Value::Array(items) = value else {
        return Ok(None);
    };
    Ok(Some(items.into_iter().filter_map(|item| T::deserialize(item).ok()).collect()))
}

fn millis<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_f64().filter(|ms| ms.is_finite() && *ms >= 0.0).map(|ms| ms as u64))
            .unwrap_or_default(),
        _ => 0,
    })
}

fn work<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<crate::work::Work>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(Some(crate::work::Work::from_value(&value)))
}

fn flag<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<bool>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Bool(flag) => Some(flag),
        Value::Number(number) => Some(number.as_f64().is_some_and(|count| count > 0.0)),
        _ => None,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireTool {
    #[serde(deserialize_with = "lenient")]
    pub name: String,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub spoken: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireMessage {
    #[serde(deserialize_with = "lenient")]
    pub id: String,
    #[serde(deserialize_with = "millis")]
    pub at: u64,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub role: String,
    #[serde(deserialize_with = "lenient")]
    pub kind: String,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub send_id: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub tool: Option<WireTool>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub handoff_id: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub comm: Option<crate::exchange::WireComm>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub room_request: Option<crate::exchange::RoomRequest>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub exchange: Option<crate::exchange::WireExchange>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub card: Option<WireCard>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub from: Option<WireFrom>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub ran: Option<crate::receipt::TurnReceipt>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub results: Option<crate::receipt::TurnResults>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireFrom {
    #[serde(deserialize_with = "lenient")]
    pub bot_id: String,
    #[serde(deserialize_with = "lenient")]
    pub name: String,
    #[serde(deserialize_with = "lenient")]
    pub color: String,
}

fn choices<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let Value::Array(items) = value else {
        return Ok(Vec::new());
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let label = match &item {
            Value::String(text) => Some(text.trim().to_owned()),
            Value::Object(fields) => fields.get("label").and_then(Value::as_str).map(|text| text.trim().to_owned()),
            _ => None,
        };
        if let Some(label) = label.filter(|label| !label.is_empty()) {
            let label: String = label.chars().take(120).collect();
            if !out.contains(&label) {
                out.push(label);
            }
        }
    }
    Ok(out)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireQuestionOption {
    #[serde(deserialize_with = "lenient")]
    pub label: String,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireQuestion {
    #[serde(deserialize_with = "lenient")]
    pub question: String,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub multi_select: bool,
    #[serde(deserialize_with = "lenient_list")]
    pub options: Vec<WireQuestionOption>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireQuestionRequest {
    #[serde(deserialize_with = "lenient_list")]
    pub questions: Vec<WireQuestion>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireCard {
    #[serde(deserialize_with = "lenient")]
    pub title: String,
    #[serde(deserialize_with = "lenient")]
    pub subtitle: String,
    #[serde(deserialize_with = "choices")]
    pub options: Vec<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub request_type: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub answered: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub answered_text: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub dismissed: bool,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub held: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub expired: bool,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub allow_key: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub allow_session: bool,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub answer_scope: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub approval_scope: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub auto_applied: bool,
    #[serde(deserialize_with = "lenient")]
    pub undone: bool,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub native_actor_label: Option<String>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub question_request: Option<WireQuestionRequest>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub answered_by: Option<Value>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub routine_request: Option<Value>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub skill_request: Option<Value>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub profile_request: Option<Value>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub model_request: Option<Value>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub outbound_request: Option<Value>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub takeover_request: Option<Value>,
    #[serde(deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub command_allowlist: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireGroup {
    #[serde(deserialize_with = "lenient")]
    pub id: String,
    #[serde(deserialize_with = "lenient")]
    pub thread_id: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub name: Option<String>,
    #[serde(deserialize_with = "lenient_optional_list")]
    pub member_ids: Option<Vec<String>>,
    #[serde(deserialize_with = "flag")]
    pub unread: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    pub section: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub busy_bot_id: Option<String>,
    #[serde(deserialize_with = "flag")]
    pub working: Option<bool>,
    #[serde(deserialize_with = "flag")]
    pub dm: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    pub default_responder: Option<Value>,
    #[serde(deserialize_with = "work")]
    pub work: Option<Option<crate::work::Work>>,
    #[serde(deserialize_with = "flag")]
    pub has_more: Option<bool>,
    #[serde(deserialize_with = "lenient_optional_list")]
    pub messages: Option<Vec<WireMessage>>,
}

impl WireMessage {
    pub fn is_from_person(&self) -> bool {
        self.role == "user"
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelSelection {
    #[serde(deserialize_with = "lenient")]
    pub instance_id: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireBot {
    #[serde(deserialize_with = "lenient")]
    pub id: String,
    #[serde(deserialize_with = "lenient")]
    pub thread_id: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub name: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub activity: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub color: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub mascot_body: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub section: Option<String>,
    #[serde(deserialize_with = "flag")]
    pub pinned: Option<bool>,
    #[serde(deserialize_with = "flag")]
    pub hidden: Option<bool>,
    #[serde(deserialize_with = "flag")]
    pub chief_of_staff: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    pub model_selection: Option<ModelSelection>,
    #[serde(deserialize_with = "flag")]
    pub busy: Option<bool>,
    #[serde(deserialize_with = "flag")]
    pub unread: Option<bool>,
    #[serde(deserialize_with = "flag")]
    pub waiting_for_teammates: Option<bool>,
    #[serde(deserialize_with = "flag")]
    pub has_more: Option<bool>,
    #[serde(deserialize_with = "work")]
    pub work: Option<Option<crate::work::Work>>,
    #[serde(deserialize_with = "lenient_optional_list")]
    pub messages: Option<Vec<WireMessage>>,
    #[serde(deserialize_with = "lenient_optional_list")]
    pub always_allow: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BotsPage {
    #[serde(deserialize_with = "lenient_list")]
    pub bots: Vec<WireBot>,
    #[serde(deserialize_with = "lenient_list")]
    pub sections: Vec<String>,
    #[serde(deserialize_with = "lenient_list")]
    pub groups: Vec<WireGroup>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThreadPage {
    #[serde(deserialize_with = "lenient_list")]
    pub messages: Vec<WireMessage>,
    #[serde(deserialize_with = "flag")]
    pub has_more: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    pub active_leaf_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SendReceipt {
    #[serde(deserialize_with = "lenient")]
    pub message: Option<WireMessage>,
    #[serde(deserialize_with = "lenient")]
    pub thread_id: Option<String>,
    #[serde(deserialize_with = "flag")]
    pub queued: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    pub queue_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendBody<'a> {
    pub text: &'a str,
    pub send_id: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub thread_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deliver: Option<&'a str>,
}

impl<'a> SendBody<'a> {
    pub fn for_item(item: &'a crate::outbox::Item) -> Self {
        let deliver = match &item.target {
            crate::outbox::Target::Bot { deliver, .. } => deliver.as_deref(),
            crate::outbox::Target::Group { .. } => None,
        };
        Self {
            text: &item.text,
            send_id: &item.send_id,
            thread_id: &item.thread_id,
            reply_to_id: item.reply_to_id.as_deref(),
            deliver,
        }
    }

    pub fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

pub fn send_path(item: &crate::outbox::Item) -> String {
    match &item.target {
        crate::outbox::Target::Bot { bot_id, .. } => format!("/api/bots/{bot_id}/messages"),
        crate::outbox::Target::Group { group_id } => format!("/api/groups/{group_id}/messages"),
    }
}

pub fn parse<T: DeserializeOwned>(raw: &str) -> Option<T> {
    serde_json::from_str(raw).ok()
}
