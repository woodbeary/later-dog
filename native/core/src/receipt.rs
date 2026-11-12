use serde::{Deserialize, Serialize};

pub const RECEIPT_RAN_ON: &str = "Ran on {account} \u{b7} {ran}";
pub const RECEIPT_RAN: &str = "Ran on {ran}";
pub const RECEIPT_SELECTED: &str = "selected {selected}";
pub const RESULTS_FILES: &str = "Changed {count} files";
pub const RESULTS_FILES_ONE: &str = "Changed 1 file";
pub const RESULTS_MORE: &str = "+{count} more";
pub const RESULTS_PULL_REQUEST: &str = "Pull request:";
pub const RESULTS_COMMANDS: &str = "Ran {count} commands";
pub const RESULTS_COMMANDS_ONE: &str = "Ran 1 command";
pub const ACTION_HOW_IT_RAN: &str = "Show what ran this";
pub const ACTION_RAN_AND_CHANGED: &str = "Show what ran and what changed";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReceiptSelection {
    pub instance_id: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TurnReceipt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub instance_id: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reported_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<ReceiptSelection>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResultFile {
    pub path: String,
    pub change: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResultLink {
    pub kind: String,
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TurnResults {
    pub files: Vec<ResultFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub more_files: Option<u64>,
    pub links: Vec<ResultLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<u64>,
}

impl TurnResults {
    pub fn any(&self) -> bool {
        !self.files.is_empty() || !self.links.is_empty() || self.commands.unwrap_or(0) > 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RanLine {
    Receipt { text: String },
    Files { text: String },
    File { path: String, change: String },
    More { text: String },
    Link { lead: Option<String>, label: String, url: String },
    Commands { text: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RanBlock {
    pub action: &'static str,
    pub lines: Vec<RanLine>,
}

fn effort_name(level: &str, instance_id: &str) -> String {
    let claude = instance_id == "claude";
    match level {
        "none" => "Off",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" if claude => "xHigh",
        "xhigh" => "Extra high",
        "max" => "Max",
        "ultra" if claude => "Ultracode",
        "ultra" => "Ultra",
        other => return other.to_owned(),
    }
    .to_owned()
}

pub fn receipt_line(receipt: Option<&TurnReceipt>) -> Option<String> {
    let receipt = receipt.filter(|receipt| !receipt.model.is_empty())?;
    let mut ran = vec![receipt.reported_model.clone().unwrap_or_else(|| receipt.model.clone())];
    if let Some(effort) = &receipt.effort {
        ran.push(effort_name(effort, &receipt.instance_id));
    }
    let ran = ran.join(" \u{b7} ");
    let line = match &receipt.account {
        Some(account) => crate::words::fill(RECEIPT_RAN_ON, &[("account", account), ("ran", &ran)]),
        None => crate::words::fill(RECEIPT_RAN, &[("ran", &ran)]),
    };
    let Some(chosen) = &receipt.selected else { return Some(line) };
    let mut picked: Vec<String> = Vec::new();
    if chosen.model != receipt.model {
        picked.push(chosen.model.clone());
    }
    if let Some(effort) = chosen.effort.as_ref().filter(|effort| Some(*effort) != receipt.effort.as_ref()) {
        picked.push(effort_name(effort, &chosen.instance_id));
    }
    if picked.is_empty() {
        return Some(line);
    }
    Some(format!("{line} \u{b7} {}", crate::words::fill(RECEIPT_SELECTED, &[("selected", &picked.join(" \u{b7} "))])))
}

pub fn ran_block(receipt: Option<&TurnReceipt>, results: Option<&TurnResults>) -> Option<RanBlock> {
    let results = results.filter(|results| results.any());
    if receipt.is_none() && results.is_none() {
        return None;
    }
    let action = if results.is_some() { ACTION_RAN_AND_CHANGED } else { ACTION_HOW_IT_RAN };
    let mut lines = Vec::new();
    if let Some(text) = receipt_line(receipt) {
        lines.push(RanLine::Receipt { text });
    }
    if let Some(results) = results {
        if !results.files.is_empty() {
            let changed = results.files.len() as u64 + results.more_files.unwrap_or(0);
            let text = if changed == 1 { RESULTS_FILES_ONE.to_owned() } else { crate::words::fill(RESULTS_FILES, &[("count", &changed.to_string())]) };
            lines.push(RanLine::Files { text });
            for file in &results.files {
                lines.push(RanLine::File { path: file.path.clone(), change: file.change.clone() });
            }
            if let Some(more) = results.more_files.filter(|more| *more > 0) {
                lines.push(RanLine::More { text: crate::words::fill(RESULTS_MORE, &[("count", &more.to_string())]) });
            }
        }
        for link in &results.links {
            let lead = (link.kind == "pull-request").then(|| RESULTS_PULL_REQUEST.to_owned());
            lines.push(RanLine::Link { lead, label: link.label.clone(), url: link.url.clone() });
        }
        if let Some(count) = results.commands.filter(|count| *count > 0) {
            let text = if count == 1 { RESULTS_COMMANDS_ONE.to_owned() } else { crate::words::fill(RESULTS_COMMANDS, &[("count", &count.to_string())]) };
            lines.push(RanLine::Commands { text });
        }
    }
    Some(RanBlock { action, lines })
}
