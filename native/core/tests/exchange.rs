use laterdog_core::exchange::{details, gist, state, WireExchange};
use laterdog_core::store::{RowKind, Store};
use laterdog_core::wire::{parse, BotsPage};

fn record(raw: &str) -> WireExchange {
    serde_json::from_str(raw).expect("record")
}

const SENT: &str = r#"{"id":"s1","at":2,"role":"bot","kind":"activity","handoffId":"h","tool":{"name":"Sent to Engineer","ok":true},
  "comm":{"groupId":"g","threadId":"x","withBotId":"e","withName":"Engineer","withColor":"green","direction":"to"}"#;

fn page(sent: &str, extra: &str) -> Store {
    let raw = format!(
        r#"{{"bots":[
          {{"id":"p","threadId":"tp","name":"Pepper","messages":[{{"id":"u","at":1,"role":"user","kind":"text","text":"ask Engineer"}},{sent}{extra}{{"id":"z","at":9,"role":"bot","kind":"text","text":"Assigned"}}]}},
          {{"id":"e","threadId":"te","name":"Eng","color":"teal","mascotBody":"corgi"}}
        ]}}"#
    );
    let mut store = Store::new([2; 16]);
    store.apply_page(parse::<BotsPage>(&raw).expect("page"));
    store
}

#[test]
fn a_message_line_with_a_record_reads_as_one_quiet_row() {
    let sent = format!(r#"{SENT}, "exchange":{{"id":"h","status":"running","to":"Engineer","request":"@Engineer  Check the\nCSV export","owner":{{"dog":"Pepper","person":false}},"from":"Pepper"}}}},"#);
    let view = page(&sent, "").view();
    let rows: Vec<_> = view.transcript.iter().map(|row| (row.kind, row.text.clone())).collect();
    assert_eq!(rows[1], (RowKind::Exchange, "Messaged Eng: Check the CSV export \u{b7} Working".to_owned()));
    let line = view.transcript[1].exchange.clone().expect("line");
    assert_eq!((line.name.as_str(), line.color.as_str(), line.body.as_str()), ("Eng", "teal", "corgi"));
    assert_eq!(line.details.heading, "Pepper asked Engineer \u{b7} started by Pepper");
    assert_eq!(line.details.reply, None);
}

#[test]
fn without_a_record_the_line_folds_into_work_as_before() {
    let view = page(&format!("{SENT}}},"), "").view();
    assert_eq!(view.transcript[1].kind, RowKind::Work);
    assert_eq!(view.transcript[1].text, "Sent to Engineer");
    assert!(view.transcript[1].exchange.is_none());
}

#[test]
fn the_record_on_the_following_request_is_used_and_that_request_is_folded_in() {
    let from = r#"{"id":"f1","at":2,"role":"bot","kind":"activity","tool":{"name":"Message from Fixture Starter","ok":true},"comm":{"withBotId":"e","withName":"Engineer","withColor":"green","direction":"from"}},"#;
    let request = r#"{"id":"r1","at":3,"role":"bot","kind":"text","text":"@Eng Check it","roomRequest":{"id":"h","phase":"request"},"exchange":{"id":"h","status":"completed","to":"Eng","request":"Check it","reply":"All good","owner":{"dog":"Pepper","person":true}}},"#;
    let view = page(from, request).view();
    let texts: Vec<_> = view.transcript.iter().map(|row| row.text.clone()).collect();
    assert_eq!(texts, ["ask Engineer", "Message from Eng: Check it \u{b7} Done", "Assigned"]);
    let details = view.transcript[1].exchange.clone().expect("line").details;
    assert_eq!(details.heading, "Eng \u{b7} your request, handled by Pepper");
    assert_eq!(details.reply.as_deref(), Some("All good"));
}

#[test]
fn record_states_read_like_the_desktop() {
    let with = |status: &str, reply: &str| record(&format!(r#"{{"status":"{status}","to":"E","request":"r"{reply}}}"#));
    assert_eq!(state(&with("queued", "")), "Queued");
    assert_eq!(state(&with("running", "")), "Working");
    assert_eq!(state(&with("waiting", "")), "Working");
    assert_eq!(state(&with("needs-you", "")), "Needs you");
    assert_eq!(state(&with("completed", "")), "Working");
    assert_eq!(state(&with("completed", r#","reply":"ok""#)), "Done");
    assert_eq!(state(&with("failed", "")), "Failed");
    assert_eq!(state(&with("cancelled", "")), "Stopped");
    assert_eq!(state(&with("brand-new", "")), "Working");
}

#[test]
fn details_name_the_wait_and_why_it_ended() {
    let shown = details(&record(r#"{"status":"cancelled","to":"E","request":"r","owner":{"dog":"P","person":true},"waitingOn":["A","B"],"endedBy":"timeout"}"#));
    assert_eq!(shown.waiting.as_deref(), Some("Waiting for A, B"));
    assert_eq!(shown.ended.as_deref(), Some("Ran out of time"));
    let shown = details(&record(r#"{"status":"cancelled","to":"E","request":"r","endedBy":"api"}"#));
    assert_eq!(shown.ended, None);
}

#[test]
fn gists_drop_mentions_squash_space_and_stop_at_ninety() {
    assert_eq!(gist("@A @B  do\tthis"), Some("do this".to_owned()));
    assert_eq!(gist("@A"), None);
    assert_eq!(gist(&"x".repeat(95)), Some(format!("{}\u{2026}", "x".repeat(89))));
    assert_eq!(gist(&"x".repeat(90)), Some("x".repeat(90)));
}
