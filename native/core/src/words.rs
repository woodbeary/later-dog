pub const CHAT_WAITING_ON: &str = "Waiting on {names}";
pub const WORK_NEEDS_YOU: &str = "Needs your answer";
pub const WORK_NEEDS_YOU_WHAT: &str = "Needs you: {what}";
pub const WORK_USAGE: &str = "Waiting for usage to reset";
pub const WORK_USAGE_ON: &str = "Waiting for usage on {account} to reset";
pub const WORK_USAGE_UNTIL: &str = "Waiting for usage until {time}";
pub const WORK_USAGE_ON_UNTIL: &str = "Waiting for usage on {account} until {time}";
pub const WORK_COMPUTER: &str = "Waiting for the computer";
pub const WORK_COMPUTER_HELD: &str = "Waiting for the computer while {name} uses it";
pub const WORK_RETRYING: &str = "Reconnecting to the engine";
pub const WORK_RETRYING_TRY: &str = "Reconnecting to the engine, try {attempt}";
pub const WORK_STOPPED_BY_YOU: &str = "Stopped by you";
pub const WORK_STOPPED_STALLED: &str = "Stopped: no progress for too long";
pub const WORK_STOPPED_CLOSED: &str = "Stopped: the engine closed";
pub const WORK_STOPPED_ENGINE: &str = "Stopped: the engine reported an error";
pub const WORK_ROOM_WORKING_ONE: &str = "{names} is working";
pub const WORK_ROOM_WORKING_MANY: &str = "{names} are working";

pub const SECTION_UNASSIGNED: &str = "Unassigned";
pub const UNREADS_COUNT: &str = "{count} unread";
pub const UNREADS_ABOVE: &str = "Jump to {count} unread chats above";
pub const UNREADS_BELOW: &str = "Jump to {count} unread chats below";

pub const EXCHANGE_MESSAGED: &str = "Messaged";
pub const EXCHANGE_MESSAGE_FROM: &str = "Message from";
pub const EXCHANGE_STATE_QUEUED: &str = "Queued";
pub const EXCHANGE_STATE_WORKING: &str = "Working";
pub const EXCHANGE_STATE_DONE: &str = "Done";
pub const EXCHANGE_STATE_NEEDS_YOU: &str = "Needs you";
pub const EXCHANGE_STATE_FAILED: &str = "Failed";
pub const EXCHANGE_STATE_STOPPED: &str = "Stopped";
pub const EXCHANGE_DETAILS: &str = "Show the request and reply";
pub const EXCHANGE_ASKED: &str = "{from} asked {to}";
pub const EXCHANGE_OWNER_PERSON: &str = "your request, handled by {dog}";
pub const EXCHANGE_OWNER_DOG: &str = "started by {dog}";
pub const EXCHANGE_REQUEST: &str = "Request";
pub const EXCHANGE_REPLY: &str = "Reply";
pub const EXCHANGE_NO_REPLY: &str = "No reply yet";
pub const EXCHANGE_WAITING_ON: &str = "Waiting for {names}";
pub const EXCHANGE_ENDED_PERSON: &str = "Stopped by you";
pub const EXCHANGE_ENDED_RESTART: &str = "Stopped when the home restarted";
pub const EXCHANGE_ENDED_TIME: &str = "Ran out of time";
pub const EXCHANGE_ENDED_LIMIT: &str = "Stopped at a usage limit";

pub fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = template.to_owned();
    for (name, value) in values {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

pub fn list(names: &[&str]) -> Option<String> {
    let mut unique: Vec<&str> = Vec::new();
    for name in names.iter().map(|name| name.trim()).filter(|name| !name.is_empty()) {
        if !unique.contains(&name) {
            unique.push(name);
        }
    }
    match unique.as_slice() {
        [] => None,
        [one] => Some((*one).to_owned()),
        [first, second] => Some(format!("{first} and {second}")),
        [rest @ .., last] => Some(format!("{}, and {last}", rest.join(", "))),
    }
}
