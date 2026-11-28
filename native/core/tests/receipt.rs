use laterdog_core::receipt::{ran_block, receipt_line, RanLine, TurnReceipt, TurnResults};
use laterdog_core::store::Store;
use laterdog_core::wire::{parse, BotsPage};

fn receipt(raw: &str) -> TurnReceipt {
    serde_json::from_str(raw).unwrap()
}

fn results(raw: &str) -> TurnResults {
    serde_json::from_str(raw).unwrap()
}

#[test]
fn the_receipt_line_names_the_account_model_effort_and_what_was_picked() {
    assert_eq!(receipt_line(Some(&receipt(r#"{"instanceId":"claude","model":"claude-opus-5-5","account":"Work"}"#))).as_deref(), Some("Ran on Work \u{b7} claude-opus-5-5"));
    assert_eq!(receipt_line(Some(&receipt(r#"{"instanceId":"codex","model":"gpt","effort":"xhigh","reportedModel":"gpt-x"}"#))).as_deref(), Some("Ran on gpt-x \u{b7} Extra high"));
    assert_eq!(
        receipt_line(Some(&receipt(r#"{"instanceId":"claude","model":"a","effort":"high","selected":{"instanceId":"claude","model":"b","effort":"ultra"}}"#))).as_deref(),
        Some("Ran on a \u{b7} High \u{b7} selected b \u{b7} Ultracode")
    );
    assert_eq!(receipt_line(Some(&receipt(r#"{"instanceId":"claude","model":""}"#))), None);
}

#[test]
fn results_list_files_links_and_commands_in_the_renderer_order() {
    let block = ran_block(None, Some(&results(r##"{"files":[{"path":"src/a.ts","change":"edited"},{"path":"b.md","change":"created"}],"moreFiles":3,"links":[{"kind":"pull-request","label":"#12","url":"https://x/pull/12"},{"kind":"page","label":"Docs","url":"https://x/docs"}],"commands":1}"##))).unwrap();
    assert_eq!(block.action, "Show what ran and what changed");
    assert_eq!(block.lines, vec![
        RanLine::Files { text: "Changed 5 files".into() },
        RanLine::File { path: "src/a.ts".into(), change: "edited".into() },
        RanLine::File { path: "b.md".into(), change: "created".into() },
        RanLine::More { text: "+3 more".into() },
        RanLine::Link { lead: Some("Pull request:".into()), label: "#12".into(), url: "https://x/pull/12".into() },
        RanLine::Link { lead: None, label: "Docs".into(), url: "https://x/docs".into() },
        RanLine::Commands { text: "Ran 1 command".into() },
    ]);
    let one = ran_block(None, Some(&results(r#"{"files":[{"path":"a","change":"deleted"}],"commands":4}"#))).unwrap();
    assert_eq!(one.lines[0], RanLine::Files { text: "Changed 1 file".into() });
    assert_eq!(one.lines.last(), Some(&RanLine::Commands { text: "Ran 4 commands".into() }));
}

#[test]
fn a_reply_with_only_a_receipt_offers_how_it_ran_and_empty_results_offer_nothing() {
    let only = ran_block(Some(&receipt(r#"{"instanceId":"claude","model":"m"}"#)), Some(&results(r#"{"files":[],"commands":0}"#))).unwrap();
    assert_eq!(only.action, "Show what ran this");
    assert_eq!(ran_block(None, Some(&results(r#"{"commands":0}"#))), None);
    assert_eq!(ran_block(None, None), None);
}

#[test]
fn only_dog_replies_carry_the_block() {
    let mut store = Store::new([2; 16]);
    store.apply_page(parse::<BotsPage>(r#"{"bots":[{"id":"d","threadId":"t","name":"Dot","messages":[
      {"id":"u","at":1,"role":"user","kind":"text","text":"go","ran":{"instanceId":"claude","model":"m"}},
      {"id":"r","at":2,"role":"bot","kind":"text","text":"done","ran":{"instanceId":"claude","model":"m","account":"Home"},"results":{"commands":2}},
      {"id":"p","at":3,"role":"bot","kind":"text","text":"plain"}]}]}"#).unwrap());
    let rows = store.view().transcript;
    assert!(rows[0].ran.is_none());
    assert_eq!(rows[1].ran.as_ref().map(|block| block.action), Some("Show what ran and what changed"));
    assert!(rows[2].ran.is_none());
}
