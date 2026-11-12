use laterdog_core::store::{machine_data, Store};
use laterdog_core::wire::{parse, BotsPage};

fn preview(messages: &str, activity: &str) -> String {
    let mut store = Store::new([5; 16]);
    let page = format!(r#"{{"bots":[{{"id":"d","threadId":"t","name":"Dot","activity":"{activity}","messages":[{messages}]}}]}}"#);
    store.apply_page(parse::<BotsPage>(&page).unwrap());
    store.view().dogs[0].preview.clone()
}

const SAID: &str = r#"{"id":"m0","at":1,"role":"bot","kind":"text","text":"All **done**."}"#;

#[test]
fn an_approval_response_reads_as_its_outcome() {
    let line = preview(&format!(r#"{SAID},{{"id":"a","at":2,"role":"bot","kind":"options","card":{{"title":"Approval needed","subtitle":"ls","options":["Allow","Deny"],"requestId":"r","tool":"Bash","answered":"allow","answerScope":"once"}}}}"#), "idle");
    assert_eq!(line, "Allowed once");
}

#[test]
fn a_tool_result_or_machine_data_is_never_the_last_line() {
    let line = preview(&format!(r#"{SAID},{{"id":"t","at":2,"role":"bot","kind":"activity","tool":{{"name":"Bash","summary":"{{\"ok\":true}}"}}}},{{"id":"j","at":3,"role":"bot","kind":"text","text":"{{\"behavior\":\"allow\",\"updatedInput\":{{}}}}"}},{{"id":"k","at":4,"role":"user","kind":"text","text":"[1, 2]"}}"#), "idle");
    assert_eq!(line, "All done.");
    assert!(machine_data(r#" {"behavior":"allow"} "#));
    assert!(!machine_data("{not json"));
    assert!(!machine_data("asked: {\"a\":1}"));
}

#[test]
fn a_card_answer_reads_as_the_card_and_a_waiting_dog_reads_as_waiting() {
    let answered = r#"{"id":"q","at":2,"role":"bot","kind":"options","card":{"title":"Which branch?","subtitle":"","options":["main"],"answered":"main","dismissed":true}}"#;
    assert_eq!(preview(&format!("{SAID},{answered}"), "idle"), "Which branch?");
    let open = r#"{"id":"a","at":3,"role":"bot","kind":"options","card":{"title":"Approval needed","subtitle":"ls","options":[],"requestId":"r","tool":"Bash"}}"#;
    assert_eq!(preview(&format!("{SAID},{open}"), "waiting-on-you"), "Waiting for you: run a command");
    let question = r#"{"id":"q2","at":3,"role":"bot","kind":"text","text":"{\"questions\":[]}"}"#;
    assert_eq!(preview(&format!("{SAID},{question}"), "waiting-on-you"), "Waiting for you\u{2026}");
}
