use laterdog_core::events::Frame;
use laterdog_core::outbox::{Failure, Target};
use laterdog_core::store::{send_id, Connection, SendState, Store};
use laterdog_core::wire::{parse, BotsPage, SendBody, SendReceipt, ThreadPage};

const PAGE: &str = r#"{
  "bots": [
    {"id":"j","threadId":"tj","name":"Juniper","activity":"idle","busy":false,"unread":true,"hasMore":false,"soul":"x",
     "messages":[
       {"id":"j1","at":1,"parentId":null,"role":"bot","kind":"text","text":"Hi, I'm Juniper."},
       {"id":"j2","at":2,"parentId":"j1","role":"user","kind":"text","text":"hello from the fixture","requestPending":false},
       {"id":"j3","at":3,"parentId":"j2","role":"bot","kind":"text","text":"hello from fake claude"},
       {"id":"j4","at":4,"parentId":"j3","role":"bot","kind":"activity","tool":{"name":"Bash","spoken":"running a few commands","summary":"echo hi"}},
       {"id":"j5","at":5,"parentId":"j4","role":"bot","kind":"digest","text":"[digest] tools"},
       {"id":"j6","at":6,"role":"bot","kind":"activity","tool":{"name":"Read","summary":"notes.md"}},
       {"id":"j7","at":7,"role":"bot","kind":"activity","tool":{"name":"Grep"}},
       "not a message",
       {"id":"j8","at":"soon","role":"bot","kind":"text","text":42}
     ]},
    {"id":"b","threadId":"tb","name":"Biscuit","unread":false,"messages":[{"id":"b1","at":1,"role":"bot","kind":"text","text":"Hi, I'm Biscuit."}]},
    {"id":"s","threadId":"ts","name":"Scout","activity":"waiting-on-you","unread":0}
  ],
  "groups": [], "sections": [], "botQueuedMessages": {}
}"#;

fn seed() -> [u8; 16] {
    [7; 16]
}

fn loaded() -> Store {
    let mut store = Store::new(seed());
    store.apply_page(parse::<BotsPage>(PAGE).expect("the page parses"));
    store
}

fn texts(store: &Store) -> Vec<(String, String, bool, Option<&'static str>)> {
    store.view().transcript.into_iter().map(|row| (row.who, row.text, row.quiet, row.status)).collect()
}

fn frame(raw: &str) -> Frame {
    Frame::parse(raw).expect("a frame")
}

fn line(who: &str, text: &str) -> (String, String, bool, Option<&'static str>) {
    (who.to_owned(), text.to_owned(), false, None)
}

fn quiet(text: &str) -> (String, String, bool, Option<&'static str>) {
    ("Juniper".to_owned(), text.to_owned(), true, None)
}

#[test]
fn the_page_lists_dogs_in_server_order_with_one_state_word_and_unread() {
    let view = loaded().view();
    let dogs: Vec<(&str, &str, bool, bool)> =
        view.dogs.iter().map(|row| (row.name.as_str(), row.state, row.unread, row.selected)).collect();
    assert_eq!(dogs, [("Juniper", "Idle", true, true), ("Biscuit", "Idle", false, false), ("Scout", "Needs you", false, false)]);
    assert_eq!(view.title, "Juniper");
    assert_eq!(view.connection, Connection::Connecting);
}

#[test]
fn the_transcript_reads_as_lines_with_quiet_activity_and_no_digests() {
    assert_eq!(
        texts(&loaded()),
        [
            line("Juniper", "Hi, I'm Juniper."),
            line("You", "hello from the fixture"),
            line("Juniper", "hello from fake claude"),
            quiet("running a few commands"),
            quiet("notes.md"),
            quiet("Grep"),
        ]
    );
}

#[test]
fn selecting_a_dog_shows_its_own_transcript() {
    let mut store = loaded();
    assert!(store.select("b"));
    assert!(!store.select("b"));
    assert!(!store.select("nobody"));
    assert_eq!(texts(&store), [line("Biscuit", "Hi, I'm Biscuit.")]);
    assert_eq!(store.find_dog("scout").as_deref(), Some("s"));
}

#[test]
fn a_new_message_frame_adds_a_row_and_a_repeat_does_not_double_it() {
    let mut store = loaded();
    let raw = r#"{"kind":"message","threadId":"tj","message":{"id":"j9","at":9,"role":"bot","kind":"text","text":"more"},"seq":50}"#;
    let changes = store.apply_frame(&frame(raw));
    assert!(changes.transcript);
    store.apply_frame(&frame(raw));
    let rows = texts(&store);
    assert_eq!(rows.len(), 7);
    assert_eq!(rows.last(), Some(&line("Juniper", "more")));
}

#[test]
fn a_patch_replaces_the_text_of_the_same_message() {
    let mut store = loaded();
    for text in ["he", "hello", "hello there"] {
        store.apply_frame(&frame(&format!(
            r#"{{"kind":"message.patch","threadId":"tj","message":{{"id":"j9","at":9,"role":"bot","kind":"text","text":"{text}"}}}}"#
        )));
    }
    let rows = texts(&store);
    assert_eq!(rows.len(), 7);
    assert_eq!(rows.last(), Some(&line("Juniper", "hello there")));
}

#[test]
fn a_message_for_another_dog_does_not_touch_the_open_transcript() {
    let mut store = loaded();
    let changes = store.apply_frame(&frame(r#"{"kind":"message","threadId":"tb","message":{"id":"b2","at":2,"role":"bot","kind":"text","text":"elsewhere"}}"#));
    assert!(!changes.transcript);
    assert_eq!(texts(&store).len(), 6);
    store.select("b");
    assert_eq!(texts(&store).last(), Some(&line("Biscuit", "elsewhere")));
}

#[test]
fn bot_frames_change_only_the_fields_they_carry() {
    let mut store = loaded();
    let changes = store.apply_frame(&frame(r#"{"kind":"bot","bot":{"id":"b","activity":"working","busy":true}}"#));
    assert!(changes.sidebar && !changes.transcript);
    store.apply_frame(&frame(r#"{"kind":"bot","bot":{"id":"b","unread":true}}"#));
    let biscuit = store.view().dogs.into_iter().find(|row| row.id == "b").expect("Biscuit");
    assert_eq!((biscuit.name.as_str(), biscuit.state, biscuit.unread), ("Biscuit", "Working", true));
    store.apply_frame(&frame(r#"{"kind":"bot","bot":{"id":"b","activity":"idle","busy":false}}"#));
    assert_eq!(store.view().dogs[1].state, "Idle");
}

#[test]
fn a_new_dog_appears_first_and_a_deleted_one_goes() {
    let mut store = loaded();
    store.apply_frame(&frame(r#"{"kind":"bot","bot":{"id":"n","threadId":"tn","name":"Nova"}}"#));
    assert_eq!(store.view().dogs[0].name, "Nova");
    store.apply_frame(&frame(r#"{"kind":"bot.deleted","botId":"j"}"#));
    let view = store.view();
    assert!(view.dogs.iter().all(|row| row.id != "j"));
    assert_eq!(view.selected.as_deref(), Some("n"));
}

#[test]
fn hello_means_connected_and_unknown_frames_change_nothing() {
    let mut store = loaded();
    assert!(store.apply_frame(&frame(r#"{"kind":"hello","cursor":"a:1","resumed":false}"#)).any());
    assert_eq!(store.view().status, "Connected");
    assert!(!store.apply_frame(&frame(r#"{"kind":"runtime","event":{}}"#)).any());
    assert!(!store.apply_frame(&Frame::Ping).any());
    store.set_connection(Connection::Reconnecting);
    assert_eq!(store.view().status, "Reconnecting to your home");
}

#[test]
fn an_older_page_of_the_thread_slots_in_by_time() {
    let mut store = loaded();
    let page: ThreadPage = parse(r#"{"messages":[{"id":"j0","at":0,"role":"user","kind":"text","text":"first words"}],"hasMore":false,"activeLeafId":"j7"}"#).expect("thread page");
    assert!(store.apply_thread("tj", page).transcript);
    assert_eq!(texts(&store)[0], line("You", "first words"));
}

#[test]
fn a_composed_message_shows_at_once_as_sending() {
    let mut store = loaded();
    let item = store.compose("walk the dog", 100).expect("composed");
    assert_eq!(item.thread_id, "tj");
    assert_eq!(item.target, Target::Bot { bot_id: "j".into(), deliver: None });
    assert_eq!(texts(&store).last(), Some(&("You".into(), "walk the dog".into(), false, Some("Sending"))));
    assert!(store.compose("   \n", 101).is_none());
    assert_eq!(SendBody::for_item(&item).json(), format!(r#"{{"text":"walk the dog","sendId":"{}","threadId":"tj"}}"#, item.send_id));
}

#[test]
fn send_ids_are_uuid_shaped_and_never_repeat() {
    let mut store = loaded();
    let ids: Vec<String> = (0..200).map(|n| store.compose("x", 100 + n / 10).expect("composed").send_id).collect();
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len());
    for id in &ids {
        let groups: Vec<usize> = id.split('-').map(str::len).collect();
        assert_eq!(groups, [8, 4, 4, 4, 12], "{id}");
        assert_eq!(&id[14..15], "4", "{id}");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "{id}");
    }
    assert_ne!(send_id(&[1; 16], 5, 1), send_id(&[2; 16], 5, 1));
}

#[test]
fn a_delivered_send_is_replaced_by_the_servers_copy() {
    let mut store = loaded();
    let item = store.compose("walk the dog", 100).expect("composed");
    assert_eq!(store.due(100), [item.clone()]);
    let receipt: SendReceipt = parse(&format!(
        r#"{{"ok":true,"threadId":"tj","message":{{"id":"j10","at":10,"role":"user","kind":"text","text":"walk the dog","sendId":"{}"}}}}"#,
        item.send_id
    ))
    .expect("receipt");
    store.send_succeeded(&item.send_id, receipt);
    let rows = store.view().transcript;
    assert_eq!(rows.iter().filter(|row| row.text == "walk the dog").count(), 1);
    let sent = rows.last().expect("a row");
    assert_eq!((sent.id.as_str(), sent.status), ("j10", Some("Sent")));
    assert!(store.due(200).is_empty());
}

#[test]
fn the_servers_copy_arriving_first_by_frame_replaces_the_local_line() {
    let mut store = loaded();
    let item = store.compose("walk the dog", 100).expect("composed");
    store.due(100);
    store.apply_frame(&frame(&format!(
        r#"{{"kind":"message","threadId":"tj","message":{{"id":"j10","at":10,"role":"user","kind":"text","text":"walk the dog","sendId":"{}"}}}}"#,
        item.send_id
    )));
    let rows = store.view().transcript;
    assert_eq!(rows.iter().filter(|row| row.text == "walk the dog").count(), 1);
    assert_eq!(rows.last().map(|row| (row.id.as_str(), row.status)), Some(("j10", Some("Sending"))));
    store.send_succeeded(&item.send_id, SendReceipt::default());
    assert_eq!(store.view().transcript.last().and_then(|row| row.status), Some("Sent"));
}

#[test]
fn a_queued_receipt_counts_as_sent_and_keeps_the_words_until_the_copy_lands() {
    let mut store = loaded();
    let item = store.compose("later please", 100).expect("composed");
    store.due(100);
    let receipt: SendReceipt = parse(&format!(r#"{{"queued":true,"queueId":"{}","threadId":"tj"}}"#, item.send_id)).expect("receipt");
    store.send_succeeded(&item.send_id, receipt);
    assert_eq!(texts(&store).last(), Some(&("You".into(), "later please".into(), false, Some("Sent"))));
}

#[test]
fn an_unreachable_home_holds_the_send_then_it_goes_through() {
    let mut store = loaded();
    let item = store.compose("walk the dog", 100).expect("composed");
    store.due(100);
    store.send_failed(&item.send_id, &Failure::Network, 100);
    assert_eq!(store.send_state(&item.send_id), Some(SendState::Held));
    assert_eq!(texts(&store).last().and_then(|row| row.3), Some("Sends when your home is up"));
    assert_eq!(store.next_wake_ms(), Some(2_100));
    assert!(store.due(2_000).is_empty());
    assert_eq!(store.due(2_100), [item.clone()]);
    store.send_succeeded(&item.send_id, SendReceipt::default());
    assert_eq!(store.send_state(&item.send_id), Some(SendState::Sent));
}

#[test]
fn a_refused_send_is_not_sent_and_keeps_its_words() {
    let mut store = loaded();
    let item = store.compose("keep these words", 100).expect("composed");
    store.due(100);
    let changes = store.send_failed(&item.send_id, &Failure::Status { code: 400, retry_after_ms: None }, 100);
    assert!(changes.transcript);
    assert_eq!(store.send_state(&item.send_id), Some(SendState::NotSent));
    assert_eq!(texts(&store).last(), Some(&("You".into(), "keep these words".into(), false, Some("Not sent"))));
    assert!(store.due(10_000).is_empty());
    assert!(store.next_wake_ms().is_none());
}

#[test]
fn nothing_is_composed_without_a_dog() {
    let mut store = Store::new(seed());
    assert!(store.compose("hello", 1).is_none());
    assert!(store.view().transcript.is_empty());
}

#[test]
fn a_page_without_bots_or_with_junk_is_empty_not_an_error() {
    assert_eq!(parse::<BotsPage>(r#"{"bots":null}"#).map(|page| page.bots.len()), Some(0));
    assert_eq!(parse::<BotsPage>(r#"{"bots":[{"id":"x","unread":"yes","busy":null,"messages":7}]}"#).map(|page| page.bots.len()), Some(1));
    assert!(parse::<BotsPage>("<html>").is_none());
}
