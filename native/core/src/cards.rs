use serde::Serialize;

use crate::wire::{WireCard, WireQuestion};
use crate::words::fill;

pub const LETTERS: [&str; 6] = ["A", "B", "C", "D", "E", "F"];
pub const QUESTION_LETTERS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
pub const MAX_CUSTOM_ANSWER: usize = 2000;
pub const ANSWER_PREAMBLE: &str = "The person answered your questions.";
pub const LEGACY_ANSWER_PREAMBLE: &str = "The user answered your questions.";
pub const QUESTION_DISMISS_MESSAGE: &str = "later.dog: they closed this question without answering, so do not ask it again. If you can go on without the answer, use your best judgment; if not, stop. Either way, reply in one short line written to them as \"you\".";
pub const MAC_ALLOW_KEY: &str = "mac";
pub const DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY: &str = "Delete folders outside its workspace";

pub const SENDING: &str = "Sending\u{2026}";
pub const CUSTOM_PLACEHOLDER: &str = "Type your own answer";
pub const DISMISS: &str = "Dismiss question";
pub const QUESTION_NAMED: &str = "{name} has a question";
pub const QUESTION_TITLE: &str = "Your dog has a question";
pub const QUESTION_ORIGIN: &str = "Written by the dog";
pub const QUESTION_TAB: &str = "Question {index}";
pub const QUESTION_STEP: &str = "{current} of {count}";
pub const QUESTION_NEXT: &str = "Next";
pub const QUESTION_BACK: &str = "Back";
pub const QUESTION_MULTI_HINT: &str = "Choose all that apply";
pub const QUESTION_OTHER: &str = "Other";
pub const QUESTION_OTHER_PLACEHOLDER: &str = "Type your own answer";
pub const QUESTION_SUBMIT: &str = "Submit answer";
pub const QUESTION_SUBMIT_ALL: &str = "Submit answers";
pub const QUESTION_ANSWERED: &str = "Answered";
pub const QUESTION_WAITING: &str = "Waiting for your answer";
pub const QUESTION_ANSWERED_LABEL: &str = "You answered: {answer}";
pub const QUESTION_CLOSE: &str = "Close question";
pub const RESOLVED_EXTERNALLY: &str = "Resolved externally";
pub const REQUESTED_BY: &str = "Requested by {label}";

pub const APPROVAL_SOMEONE: &str = "Someone";
pub const APPROVAL_NAMED_WANTS_TO: &str = "{name} wants to {action}";
pub const APPROVAL_WANTS_TO: &str = "Wants to {action}";
pub const APPROVAL_ASK_NAMED: &str = "Let {name} {action}?";
pub const APPROVAL_ASK_UNNAMED: &str = "Allow it to {action}?";
pub const APPROVAL_WAITING_ANSWER: &str = "Waiting for your answer below";
pub const APPROVAL_WAITING_CONFIRMATION: &str = "Waiting for your confirmation below";
pub const APPROVAL_POSITION: &str = "{index} of {count}";
pub const APPROVAL_PENDING: &str = "Pending approval";
pub const APPROVAL_VIEW_DETAILS: &str = "View details";
pub const APPROVAL_REACH_WHAT: &str = "What this covers";
pub const APPROVAL_BY_VOICE: &str = "by voice";
pub const DECLINED: &str = "Declined.";

pub const UNREACHABLE_MESSAGE: &str = "Couldn't reach later.dog. Check that it's running and that you're online, then try again.";
pub const TOO_SLOW_MESSAGE: &str = "later.dog took too long to answer. Try again in a moment.";
pub const GENERIC_MESSAGE: &str = "Something went wrong. Try again.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardKind {
    Options,
    Question,
    Approval,
    Other,
}

pub fn kind(card: &WireCard) -> CardKind {
    if card.takeover_request.is_some() {
        return CardKind::Other;
    }
    let requested = card.request_id.as_deref().is_some_and(|id| !id.is_empty());
    if requested && card.question_request.is_some() {
        return CardKind::Question;
    }
    if requested && card.tool.as_deref().is_some_and(|tool| !tool.is_empty()) {
        return CardKind::Approval;
    }
    CardKind::Options
}

pub fn is_proposal(card: &WireCard) -> bool {
    card.routine_request.is_some() || card.skill_request.is_some() || card.profile_request.is_some() || card.model_request.is_some()
}

fn durable(card: &WireCard) -> bool {
    card.routine_request.is_some() || card.skill_request.is_some() || card.profile_request.is_some()
}

pub fn is_onboarding(card: &WireCard) -> bool {
    card.request_id.as_deref().is_none_or(str::is_empty)
}

pub fn persistent_question(card: &WireCard) -> bool {
    card.request_type.as_deref() == Some("question")
        || card.question_request.is_some()
        || (card.request_type.is_none() && card.tool.is_none() && !durable(card) && card.model_request.is_none())
}

pub fn can_dismiss_option(card: &WireCard) -> bool {
    if !is_onboarding(card) && persistent_question(card) {
        return !card.dismissed;
    }
    true
}

pub fn option_title(card: &WireCard, bot_name: Option<&str>) -> String {
    if is_onboarding(card) || card.request_type.as_deref() != Some("question") {
        return card.title.clone();
    }
    match bot_name {
        Some(name) => fill(QUESTION_NAMED, &[("name", name)]),
        None => QUESTION_TITLE.to_owned(),
    }
}

pub fn option_choices(card: &WireCard) -> Vec<String> {
    card.options.iter().take(LETTERS.len()).cloned().collect()
}

pub fn chosen_answer(card: &WireCard, picked: Option<&str>) -> Option<String> {
    if let Some(text) = &card.answered_text {
        return Some(text.clone());
    }
    if let Some(answered) = card.answered.as_deref().filter(|answered| !matches!(*answered, "answer" | "allow" | "deny")) {
        return Some(answered.to_owned());
    }
    picked.map(str::to_owned)
}

pub fn answer_without_preamble(answer: &str) -> &str {
    for preamble in [ANSWER_PREAMBLE, LEGACY_ANSWER_PREAMBLE] {
        if let Some(rest) = answer.strip_prefix(preamble).and_then(|rest| rest.strip_prefix("\n\n")) {
            return rest;
        }
    }
    answer
}

pub fn format_answers(questions: &[WireQuestion], answers: &[Vec<String>]) -> String {
    let mut blocks = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        let picked: Vec<&str> = answers.get(index).map(|list| list.iter().map(|value| value.trim()).filter(|value| !value.is_empty()).collect()).unwrap_or_default();
        if picked.is_empty() {
            continue;
        }
        blocks.push(format!("Q: {}\nA: {}", question.question, picked.join(", ")));
    }
    if blocks.is_empty() {
        return String::new();
    }
    format!("{ANSWER_PREAMBLE}\n\n{}", blocks.join("\n\n"))
}

pub fn settled_answer(answer: &str, questions: &[WireQuestion]) -> String {
    let text = answer_without_preamble(answer);
    if questions.len() != 1 {
        return text.to_owned();
    }
    let prefix = format!("Q: {}\nA: ", questions[0].question);
    text.strip_prefix(&prefix).unwrap_or(text).to_owned()
}

pub fn answer_summary(answer: &str, questions: &[WireQuestion]) -> String {
    let text = settled_answer(answer, questions);
    let mut answers = Vec::new();
    for block in text.split("\n\nQ: ") {
        let block = block.strip_prefix("Q: ").unwrap_or(block);
        if let Some((_, answer)) = block.split_once("\nA: ") {
            let answer = answer.trim();
            if !answer.is_empty() {
                answers.push(answer.to_owned());
            }
        }
    }
    let joined = if answers.is_empty() || !text.starts_with("Q: ") { text } else { answers.join(" \u{b7} ") };
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub picked: Vec<String>,
    pub custom: String,
    pub other: bool,
}

impl Draft {
    pub fn answers(&self) -> Vec<String> {
        let custom = if self.other { self.custom.trim().to_owned() } else { String::new() };
        let mut answers = self.picked.clone();
        if !custom.is_empty() {
            answers.push(custom);
        }
        answers
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuestionDraft {
    pub drafts: Vec<Draft>,
    pub active: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    Stay,
    Submit(String),
}

impl QuestionDraft {
    pub fn new(count: usize) -> Self {
        QuestionDraft { drafts: vec![Draft::default(); count.max(1)], active: 0 }
    }

    fn current(&self, questions: &[WireQuestion]) -> usize {
        self.active.min(questions.len().saturating_sub(1))
    }

    pub fn answered(&self) -> Vec<bool> {
        self.drafts.iter().map(|draft| !draft.answers().is_empty()).collect()
    }

    pub fn complete(&self, questions: &[WireQuestion]) -> bool {
        questions.len() == self.answered().iter().take(questions.len()).filter(|done| **done).count()
    }

    pub fn choose(&mut self, questions: &[WireQuestion], label: &str) -> Choice {
        let index = self.current(questions);
        let Some(question) = questions.get(index) else { return Choice::Stay };
        let draft = &mut self.drafts[index];
        if question.multi_select {
            if let Some(at) = draft.picked.iter().position(|entry| entry == label) {
                draft.picked.remove(at);
            } else {
                draft.picked.push(label.to_owned());
            }
            return Choice::Stay;
        }
        draft.picked = vec![label.to_owned()];
        draft.other = false;
        if questions.len() == 1 {
            return Choice::Submit(format_answers(questions, &[vec![label.to_owned()]]));
        }
        if index + 1 < questions.len() {
            self.active = index + 1;
        }
        Choice::Stay
    }

    pub fn toggle_other(&mut self, questions: &[WireQuestion]) {
        let index = self.current(questions);
        let multi = questions.get(index).is_some_and(|question| question.multi_select);
        let draft = &mut self.drafts[index];
        if draft.other {
            draft.other = false;
            return;
        }
        draft.other = true;
        if !multi {
            draft.picked.clear();
        }
    }

    pub fn type_other(&mut self, questions: &[WireQuestion], text: &str) {
        let index = self.current(questions);
        self.drafts[index].custom = text.chars().take(MAX_CUSTOM_ANSWER).collect();
    }

    pub fn step(&mut self, questions: &[WireQuestion], offset: isize) {
        let last = questions.len().saturating_sub(1) as isize;
        self.active = (self.current(questions) as isize + offset).clamp(0, last) as usize;
    }

    pub fn go(&mut self, questions: &[WireQuestion], index: usize) {
        self.active = index.min(questions.len().saturating_sub(1));
    }

    pub fn submit(&self, questions: &[WireQuestion]) -> Option<String> {
        if !self.complete(questions) {
            return None;
        }
        let answers: Vec<Vec<String>> = self.drafts.iter().map(Draft::answers).collect();
        Some(format_answers(questions, &answers)).filter(|answer| !answer.is_empty())
    }

    pub fn enter(&self, questions: &[WireQuestion]) -> Option<isize> {
        let index = self.current(questions);
        let last = index + 1 == questions.len();
        if last && self.complete(questions) {
            return Some(0);
        }
        if !last && self.answered().get(index).copied().unwrap_or(false) {
            return Some(1);
        }
        None
    }
}

pub fn tool_label(tool: Option<&str>, scope: Option<&str>) -> String {
    let Some(tool) = tool.filter(|tool| !tool.is_empty()) else { return "take an action".to_owned() };
    let strip = |name: &str| -> String {
        let name = match name.strip_prefix("mcp__") {
            Some(rest) => rest.split_once("__").map_or(rest, |(_, after)| after),
            None => name,
        };
        name.strip_prefix("agents_").unwrap_or(name).to_owned()
    };
    let nice = |name: &str| -> Option<&'static str> {
        Some(match name {
            "Bash" | "shell" => "run a command",
            "Read" | "read" => "read a file",
            "Write" => "write a file",
            "Edit" | "edit" => "edit a file",
            "WebFetch" | "fetch" => "fetch a web page",
            "WebSearch" => "search the web",
            "schedule_routine" => "schedule a routine",
            "manage_routine" => "change a routine",
            "stage_skill" => "enable a learned trick",
            "update_skill" => "update a learned trick",
            "skill_manage" => "save a trick",
            "skills_list" => "look at its tricks",
            "update_profile" => "update its profile",
            "delete" => "delete a file",
            "think" => "think",
            "other" => "take an action",
            "tool" => "use a tool",
            "select_computer" => "use a computer",
            "mac_list_files" => "look in a folder on your Mac",
            "mac_read_file" => "open a file on your Mac",
            "mac_write_file" => "save a file on your Mac",
            "mac_run_command" => "run a command on your Mac",
            "mac_computer_call" => "use apps on your Mac",
            "mac_read_texts" => "read your texts on your Mac",
            "mac_send_text" => "send a text from your Mac",
            "mac_send_email" => "send an email from your Mac",
            "ask_bot" => "message another dog",
            "delegate_bot" => "hand work to another dog",
            _ => return None,
        })
    };
    if let Some(found) = nice(tool).or_else(|| nice(&strip(tool))) {
        return found.to_owned();
    }
    let bare = strip(tool).replace('_', " ");
    if uses_computer(tool) {
        return if scope == Some("local-computer") { "use this Mac" } else { "use its computer" }.to_owned();
    }
    let words: Vec<&str> = bare.split_whitespace().collect();
    if !tool.starts_with("mcp__") && (2..=3).contains(&words.len()) && words.iter().all(|word| word.chars().all(|c| c.is_ascii_alphabetic())) {
        return words.join(" ").to_lowercase();
    }
    "take an action".to_owned()
}

fn uses_computer(tool: &str) -> bool {
    let name = tool.trim();
    if let Some(rest) = name.strip_prefix("mcp__") {
        if let Some((server, tool)) = rest.split_once("__") {
            return matches!(server, "computer" | "browser") || ["computer", "browser", "screenshot", "click"].iter().any(|start| tool.starts_with(start));
        }
    }
    name.starts_with("computer_") || name.starts_with("browser_")
}

pub fn approval_action(card: &WireCard) -> String {
    let routine = card.routine_request.as_ref().and_then(|request| request.pointer("/operation/action")).and_then(|action| action.as_str());
    let skill = card.skill_request.as_ref().and_then(|request| request.get("action")).and_then(|action| action.as_str());
    let tool = match (routine, skill) {
        (Some("create"), _) => Some("schedule_routine"),
        (Some(_), _) => Some("manage_routine"),
        (None, Some("update")) => Some("update_skill"),
        (None, Some(_)) => Some("stage_skill"),
        _ if card.skill_request.is_some() => Some("stage_skill"),
        _ if card.profile_request.is_some() => Some("update_profile"),
        _ => card.tool.as_deref(),
    };
    tool_label(tool, card.approval_scope.as_deref())
}

pub fn approval_outcome(card: &WireCard) -> Option<String> {
    if card.answered.as_deref() == Some("resolved") {
        return Some(card.answered_text.clone().filter(|text| !text.is_empty()).unwrap_or_else(|| RESOLVED_EXTERNALLY.to_owned()));
    }
    if card.expired {
        return Some("No answer in time, so this didn't happen".to_owned());
    }
    let answered = card.answered.as_deref()?;
    if card.undone {
        return Some("Undone".to_owned());
    }
    if answered != "allow" {
        return Some(if is_proposal(card) { "Cancelled" } else if card.outbound_request.is_some() && answered == "deny" { "Skipped" } else { "Denied" }.to_owned());
    }
    let routine = card.routine_request.as_ref().and_then(|request| request.pointer("/operation/action")).and_then(|action| action.as_str());
    if let Some(action) = routine {
        let word = match action {
            "create" => "Routine scheduled",
            "update" => "Routine updated",
            "pause" => "Routine paused",
            "resume" => "Routine resumed",
            "run_now" => "Routine run queued",
            "delete" => "Routine deleted",
            _ => "Routine confirmed",
        };
        return Some(word.to_owned());
    }
    if let Some(skill) = card.skill_request.as_ref() {
        return Some(match skill.get("action").and_then(|action| action.as_str()) {
            Some("create") => "Trick enabled",
            Some("update") => "Trick updated",
            _ => "Trick confirmed",
        }.to_owned());
    }
    if card.profile_request.is_some() {
        return Some("Profile updated".to_owned());
    }
    if card.model_request.is_some() {
        return Some("Default model changed".to_owned());
    }
    Some(match card.answer_scope.as_deref() {
        Some("always") => "Always allowed",
        Some("chat") => "Allowed for this chat",
        Some("once") => "Allowed once",
        _ => "Allowed",
    }.to_owned())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folded {
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    pub allowed: bool,
    pub external: bool,
    pub by_voice: bool,
}

pub fn approval_folded(card: &WireCard) -> Option<Folded> {
    let outcome = approval_outcome(card)?;
    let action = if is_proposal(card) || card.expired || card.tool.is_none() {
        None
    } else {
        let phrase = tool_label(card.tool.as_deref(), card.approval_scope.as_deref());
        let mut chars = phrase.chars();
        chars.next().map(|first| format!("{}{}", first.to_uppercase(), chars.as_str()))
    };
    let external = card.answered.as_deref() == Some("resolved");
    let by_voice = card.answered_by.as_ref().and_then(|by| by.get("via")).and_then(|via| via.as_str()) == Some("call");
    Some(Folded { outcome, action, allowed: card.answered.as_deref() == Some("allow") && !card.expired, external, by_voice })
}

pub fn pending_approval(card: &WireCard) -> bool {
    kind(card) == CardKind::Approval && card.answered.is_none() && !card.dismissed && !card.expired
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Behavior {
    Allow,
    Deny,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ButtonLook {
    Primary,
    Quiet,
    Durable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub label: String,
    pub look: ButtonLook,
    pub behavior: Behavior,
    pub always: bool,
    pub never: bool,
    pub enabled: bool,
}

pub fn decisions(card: &WireCard, has_bot: bool) -> Vec<Decision> {
    let tool = card.tool.as_deref().unwrap_or_default();
    let routine = card.routine_request.is_some();
    let skill = card.skill_request.is_some();
    let profile = card.profile_request.is_some();
    let durable_request = routine || skill || profile;
    let mac_send = tool == "mac_send_text" || tool == "mac_send_email";
    let mac_request = tool.starts_with("mac_") && !mac_send;
    let outbound = card.outbound_request.is_some();
    let allow_key = card.allow_key.as_deref().filter(|key| !key.is_empty());
    let primary = if skill {
        if card.skill_request.as_ref().and_then(|request| request.get("action")).and_then(|action| action.as_str()) == Some("update") { "Update" } else { "Enable" }
    } else if routine || profile {
        "Confirm"
    } else if mac_send {
        "Send"
    } else if outbound {
        "Allow"
    } else {
        "Allow once"
    };
    let decision = |label: &str, look, behavior, always, never| Decision { label: label.to_owned(), look, behavior, always, never, enabled: true };
    let mut out = vec![Decision { enabled: !skill, ..decision(primary, ButtonLook::Primary, Behavior::Allow, false, false) }];
    if !mac_request {
        let deny = if routine || profile { "Cancel" } else if outbound { "Skip" } else if mac_send { "Don't send" } else { "Don't allow" };
        out.push(decision(deny, ButtonLook::Quiet, Behavior::Deny, false, false));
    }
    if !durable_request && has_bot && allow_key.is_some() {
        out.push(decision("Always allow", ButtonLook::Durable, Behavior::Allow, true, false));
    }
    if mac_request {
        out.push(decision("Never", ButtonLook::Durable, Behavior::Deny, false, true));
    }
    if !durable_request && allow_key.is_none() && card.allow_session {
        out.push(decision("Allow for this chat", ButtonLook::Durable, Behavior::Allow, true, false));
    }
    out
}

pub fn reach(card: &WireCard, bot_name: Option<&str>) -> Option<String> {
    let durable_request = durable(card);
    let allow_key = card.allow_key.as_deref().filter(|key| !key.is_empty());
    if let (false, Some(name), Some(key)) = (durable_request, bot_name, allow_key) {
        if card.outbound_request.is_some() {
            let app = card.outbound_request.as_ref().and_then(|request| request.get("app")).and_then(|app| app.as_str()).unwrap_or("this app");
            return Some(fill("Allow covers {app} until your next message. Always allow lets {name} use it without asking again. Skip leaves it unused until your next message.", &[("app", app), ("name", name)]));
        }
        if key == MAC_ALLOW_KEY {
            return Some("Always allow lets every dog use this Mac without asking. Never stops them using it.".to_owned());
        }
        if key == DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY {
            return Some(fill("Always allow lets {name} do this again without asking, in every chat. You can undo it in {name}'s settings.", &[("name", name)]));
        }
        return Some(fill("Always allow lets {name} do this again without asking in group chats and in new chats.", &[("name", name)]));
    }
    if !durable_request && allow_key.is_none() && card.allow_session {
        return Some("Allow for this chat stops asking about this action until this chat's session ends.".to_owned());
    }
    None
}

pub fn panel_label(card: &WireCard, bot_name: Option<&str>) -> String {
    if let Some(skill) = &card.skill_request {
        return if skill.get("action").and_then(|action| action.as_str()) == Some("update") { "Update this learned trick" } else { "Enable this learned trick" }.to_owned();
    }
    if card.profile_request.is_some() {
        return "Confirm this profile change".to_owned();
    }
    if let Some(routine) = &card.routine_request {
        return if routine.pointer("/operation/action").and_then(|action| action.as_str()) == Some("create") { "Confirm this routine" } else { "Confirm this routine change" }.to_owned();
    }
    let action = tool_label(card.tool.as_deref(), card.approval_scope.as_deref());
    match bot_name {
        Some(name) => fill(APPROVAL_ASK_NAMED, &[("name", name), ("action", &action)]),
        None => fill(APPROVAL_ASK_UNNAMED, &[("action", &action)]),
    }
}

pub fn respond_body(request_id: &str, decision: &Decision, card: &WireCard, grant_saved: bool) -> serde_json::Value {
    let allow_key = card.allow_key.as_deref().filter(|key| !key.is_empty());
    let grant = decision.always && allow_key.is_some();
    let for_chat = decision.always && allow_key.is_none() && card.allow_session;
    let scope = if decision.never {
        Some("never")
    } else if decision.behavior != Behavior::Allow {
        None
    } else if grant {
        Some(if grant_saved { "always" } else { "once" })
    } else if for_chat {
        Some("chat")
    } else {
        Some("once")
    };
    let mut body = serde_json::json!({ "requestId": request_id, "behavior": decision.behavior });
    if decision.behavior == Behavior::Deny {
        body["message"] = DECLINED.into();
    }
    if for_chat {
        body["always"] = true.into();
    }
    if let Some(scope) = scope {
        body["scope"] = scope.into();
    }
    body
}

pub fn answer_body(request_id: &str, answer: &str) -> serde_json::Value {
    serde_json::json!({ "requestId": request_id, "behavior": "answer", "message": answer })
}

pub fn dismiss_body(request_id: &str, card: &WireCard) -> serde_json::Value {
    if card.tool.is_some() {
        return serde_json::json!({ "requestId": request_id, "behavior": "deny", "message": "Closed without approving." });
    }
    serde_json::json!({ "requestId": request_id, "behavior": "answer", "message": QUESTION_DISMISS_MESSAGE, "dismiss": true })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RespondFailure {
    Network,
    Timeout,
    Status { code: u16, said: Option<String> },
}

fn bare_code(said: &str) -> bool {
    let said = said.trim();
    let token = !said.is_empty() && said.split(['_', '.', ':', '/', '-']).all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()));
    let status_line = said.split_whitespace().any(|word| word.len() == 3 && word.chars().all(|c| c.is_ascii_digit())) && said.len() < 40 && !said.contains(['.', ',']);
    token || status_line
}

pub fn plain_error(failure: &RespondFailure) -> String {
    match failure {
        RespondFailure::Network => UNREACHABLE_MESSAGE.to_owned(),
        RespondFailure::Timeout => TOO_SLOW_MESSAGE.to_owned(),
        RespondFailure::Status { code, said } => {
            if let Some(said) = said.as_deref().map(str::trim).filter(|said| !said.is_empty() && !bare_code(said)) {
                return said.to_owned();
            }
            match code {
                502..=504 => "later.dog isn't answering right now. Check that it's running, then try again.",
                401 | 403 => "later.dog didn't accept that. Sign in again or ask the person who runs this later.dog for access.",
                404 => "That isn't there any more. Refresh and try again.",
                _ => GENERIC_MESSAGE,
            }
            .to_owned()
        }
    }
}
