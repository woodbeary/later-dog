use laterdog_core::store::Store;
use laterdog_core::wire::{parse, BotsPage};
use laterdog_core::work::{line, sidebar_line, Work, WorkDog};
use laterdog_core::words::list;

fn at(until: u64, now: u64) -> String {
    format!("{until}@{now}")
}

fn work(raw: &str) -> Option<Work> {
    Work::from_value(&serde_json::from_str(raw).expect("json"))
}

fn said(raw: &str) -> Option<String> {
    line(work(raw).as_ref(), 100, &at)
}

fn side(raw: &str) -> Option<String> {
    sidebar_line(work(raw).as_ref(), 100, &at)
}

#[test]
fn every_kind_reads_in_the_desktop_words() {
    assert_eq!(said(r#"{"kind":"needs-you"}"#).as_deref(), Some("Needs your answer"));
    assert_eq!(said(r#"{"kind":"needs-you","what":"an approval"}"#).as_deref(), Some("Needs you: an approval"));
    assert_eq!(said(r#"{"kind":"waiting-for-usage"}"#).as_deref(), Some("Waiting for usage to reset"));
    assert_eq!(said(r#"{"kind":"waiting-for-usage","account":"Work"}"#).as_deref(), Some("Waiting for usage on Work to reset"));
    assert_eq!(said(r#"{"kind":"waiting-for-usage","until":500}"#).as_deref(), Some("Waiting for usage until 500@100"));
    assert_eq!(said(r#"{"kind":"waiting-for-usage","account":"Work","until":500}"#).as_deref(), Some("Waiting for usage on Work until 500@100"));
    assert_eq!(said(r#"{"kind":"waiting-for-usage","account":"Work","until":50}"#).as_deref(), Some("Waiting for usage on Work to reset"));
    assert_eq!(said(r#"{"kind":"waiting-for-computer"}"#).as_deref(), Some("Waiting for the computer"));
    assert_eq!(said(r#"{"kind":"waiting-for-computer","holder":"Scout"}"#).as_deref(), Some("Waiting for the computer while Scout uses it"));
    assert_eq!(said(r#"{"kind":"retrying"}"#).as_deref(), Some("Reconnecting to the engine"));
    assert_eq!(said(r#"{"kind":"retrying","attempt":3}"#).as_deref(), Some("Reconnecting to the engine, try 3"));
    assert_eq!(said(r#"{"kind":"stopped","cause":"you"}"#).as_deref(), Some("Stopped by you"));
    assert_eq!(said(r#"{"kind":"stopped","cause":"engine","detail":"stalled"}"#).as_deref(), Some("Stopped: no progress for too long"));
    assert_eq!(said(r#"{"kind":"stopped","cause":"engine","detail":"closed"}"#).as_deref(), Some("Stopped: the engine closed"));
    assert_eq!(said(r#"{"kind":"stopped","cause":"infrastructure"}"#).as_deref(), Some("Stopped: the engine reported an error"));
    assert_eq!(said(r#"{"kind":"waiting-on-dog","dogs":[{"id":"e","name":"Engineer"}]}"#).as_deref(), Some("Waiting on Engineer"));
    assert_eq!(said(r#"{"kind":"waiting-on-dog","dogs":[{"id":"e","name":"Engineer"},{"id":"r","name":"Reviewer"},{"id":"s","name":"Scout"}]}"#).as_deref(), Some("Waiting on Engineer, Reviewer, and Scout"));
    assert_eq!(said(r#"{"kind":"running","dogs":[{"id":"e","name":"Engineer"}]}"#).as_deref(), Some("Engineer is working"));
    assert_eq!(said(r#"{"kind":"running","dogs":[{"id":"e","name":"Engineer"},{"id":"r","name":"Reviewer"}]}"#).as_deref(), Some("Engineer and Reviewer are working"));
}

#[test]
fn quiet_kinds_say_nothing() {
    assert_eq!(said(r#"{"kind":"idle"}"#), None);
    assert_eq!(said(r#"{"kind":"running"}"#), None);
    assert_eq!(said(r#"{"kind":"waiting-on-dog","dogs":[]}"#), None);
    assert_eq!(line(None, 0, &at), None);
}

#[test]
fn unknown_or_broken_work_reads_as_absent() {
    assert_eq!(work(r#"{"kind":"dreaming"}"#), None);
    assert_eq!(work(r#""running""#), None);
    assert_eq!(work("null"), None);
    assert_eq!(work(r#"{"kind":"retrying","attempt":"two"}"#), Some(Work::Retrying { attempt: None }));
    assert_eq!(work(r#"{"kind":"waiting-on-dog","dogs":[{"id":"e","name":"Eli"},"x"]}"#), Some(Work::WaitingOnDog { dogs: vec![WorkDog { id: "e".into(), name: "Eli".into() }] }));
}

#[test]
fn the_sidebar_leaves_out_needs_you_and_stopped_by_you() {
    assert_eq!(side(r#"{"kind":"needs-you"}"#), None);
    assert_eq!(side(r#"{"kind":"stopped","cause":"you"}"#), None);
    assert_eq!(side(r#"{"kind":"stopped","cause":"engine"}"#).as_deref(), Some("Stopped: the engine reported an error"));
    assert_eq!(side(r#"{"kind":"waiting-for-computer"}"#).as_deref(), Some("Waiting for the computer"));
}

#[test]
fn names_list_in_english_without_repeats_or_blanks() {
    assert_eq!(list(&[]), None);
    assert_eq!(list(&[" ", "Eli", "Eli "]).as_deref(), Some("Eli"));
    assert_eq!(list(&["Eli", "Nora"]).as_deref(), Some("Eli and Nora"));
}

#[test]
fn the_store_keeps_work_until_the_home_changes_it() {
    let mut store = Store::new([1; 16]);
    store.apply_page(parse::<BotsPage>(r#"{"bots":[{"id":"a","threadId":"t","name":"Ann","work":{"kind":"retrying","attempt":2}},{"id":"b","threadId":"u","name":"Bo"}]}"#).expect("page"));
    let view = store.view();
    assert_eq!(view.work, Some(Work::Retrying { attempt: Some(2) }));
    assert_eq!(view.dogs[1].work, None);
    let frame = laterdog_core::events::Frame::parse(r#"{"kind":"bot","bot":{"id":"a","name":"Ann"}}"#).expect("frame");
    store.apply_frame(&frame);
    assert_eq!(store.view().work, Some(Work::Retrying { attempt: Some(2) }));
    let frame = laterdog_core::events::Frame::parse(r#"{"kind":"bot","bot":{"id":"a","work":{"kind":"idle"}}}"#).expect("frame");
    store.apply_frame(&frame);
    assert_eq!(store.view().work, Some(Work::Idle));
    let frame = laterdog_core::events::Frame::parse(r#"{"kind":"bot","bot":{"id":"a","work":{"kind":"unheard-of"}}}"#).expect("frame");
    store.apply_frame(&frame);
    assert_eq!(store.view().work, None);
}
