use laterdog_core::events::Frame;
use laterdog_core::outbox::{Failure, Target};
use laterdog_core::store::{RowKind, SendState, SidebarEntry, Store};
use laterdog_core::wire::{parse, BotsPage, SendBody, SendReceipt, ThreadPage};

const PAGE: &str = r#"{
  "bots": [
    {"id":"a","threadId":"ta","name":"Ash","color":"blue","section":"Work","messages":[]},
    {"id":"b","threadId":"tb","name":"Bo","color":"red","messages":[]},
    {"id":"c","threadId":"tc","name":"Cy","color":"green","messages":[]}
  ],
  "sections": ["Work"],
  "groups": [
    {"id":"g1","threadId":"tg1","name":"Pack","memberIds":["a","b","c"],"unread":true,"working":false,"hasMore":true,"defaultResponder":{"kind":"member","botId":"b"},"messages":[
      {"id":"m1","at":10,"role":"user","kind":"text","text":"morning"},
      {"id":"m2","at":11,"role":"bot","kind":"text","text":"hi","from":{"botId":"a","name":"Ash","color":"blue"}},
      {"id":"m3","at":12,"role":"bot","kind":"text","text":"also hi","from":{"botId":"a","name":"Ash","color":"blue"}},
      {"id":"m4","at":13,"role":"bot","kind":"text","text":"same","from":{"botId":"b","name":"Bo","color":"red"}}
    ]},
    {"id":"g2","threadId":"tg2","name":"Side","memberIds":["a"],"section":"Work","messages":[],"busyBotId":"a"},
    {"id":"dm","threadId":"tdm","name":"a and b","memberIds":["a","b"],"dm":true,"messages":[]}
  ]
}"#;

fn loaded() -> Store {
    let mut store = Store::new([9; 16]);
    store.apply_page(parse::<BotsPage>(PAGE).expect("parses"));
    store
}

#[test]
fn rooms_sit_before_dogs_in_their_section_and_dog_to_dog_rooms_stay_out() {
    let view = loaded().view();
    let order: Vec<String> = view
        .sidebar
        .iter()
        .map(|entry| match entry {
            SidebarEntry::Header { name, count, .. } => format!("# {name} {count}"),
            SidebarEntry::Dog { index } => view.dogs[*index].name.clone(),
            SidebarEntry::Room { index } => format!("room {}", view.rooms[*index].name),
        })
        .collect();
    assert_eq!(order, ["# Work 2", "room Side", "Ash", "# Unassigned 3", "room Pack", "Bo", "Cy"]);
}

#[test]
fn a_room_row_shows_two_faces_a_count_and_who_spoke_last() {
    let view = loaded().view();
    let pack = view.rooms.iter().find(|room| room.id == "g1").unwrap();
    assert_eq!(pack.faces.iter().map(|face| face.name.as_str()).collect::<Vec<_>>(), ["Ash", "Bo"]);
    assert_eq!((pack.extra, pack.unread, pack.preview.as_str()), (1, true, "Bo: same"));
    let side = view.rooms.iter().find(|room| room.id == "g2").unwrap();
    assert_eq!((side.faces.len(), side.preview.as_str()), (1, "Ash is working\u{2026}"));
}

#[test]
fn a_room_transcript_names_each_dog_once_per_run_and_puts_yours_on_the_right() {
    let mut store = loaded();
    assert!(store.select("g1"));
    assert!(!store.select("dm"));
    let view = store.view();
    assert!(view.room);
    assert_eq!(view.title, "Pack");
    assert_eq!(view.placeholder, "Message Pack \u{2014} Bo responds by default \u{2014} @mention someone else to choose them instead.");
    let rows: Vec<(bool, Option<String>, String)> = view.transcript.iter().map(|row| (row.mine, row.face.as_ref().map(|face| face.name.clone()), row.text.clone())).collect();
    assert_eq!(rows, [
        (true, None, "morning".to_owned()),
        (false, Some("Ash".to_owned()), "hi".to_owned()),
        (false, None, "also hi".to_owned()),
        (false, Some("Bo".to_owned()), "same".to_owned()),
    ]);
    assert!(view.transcript.iter().all(|row| row.room && row.kind == RowKind::Text));
}

#[test]
fn sending_in_a_room_uses_the_room_route_through_the_outbox() {
    let mut store = loaded();
    store.select("g1");
    let item = store.compose("ship it", 20).expect("queued");
    assert_eq!(item.target, Target::Group { group_id: "g1".into() });
    assert_eq!(laterdog_core::wire::send_path(&item), "/api/groups/g1/messages");
    let body: serde_json::Value = serde_json::from_str(&SendBody::for_item(&item).json()).unwrap();
    assert_eq!(body, serde_json::json!({ "text": "ship it", "sendId": item.send_id, "threadId": "tg1" }));
    store.due(20);
    store.send_failed(&item.send_id, &Failure::Network, 20);
    assert_eq!(store.send_state(&item.send_id), Some(SendState::Held));
    store.due(40_000);
    store.send_failed(&item.send_id, &Failure::Status { code: 403, retry_after_ms: None }, 40_000);
    let row = store.view().transcript.into_iter().find(|row| row.mine && row.text == "ship it").unwrap();
    assert_eq!(row.status, Some(SendState::NotSent.words()));
    assert!(store.send_again(&item.send_id).is_some());
    store.send_succeeded(&item.send_id, parse::<SendReceipt>(r#"{"threadId":"tg1","message":{"id":"m9","at":21,"role":"user","kind":"text","text":"ship it","sendId":"X"}}"#).unwrap());
    assert!(store.view().transcript.iter().any(|row| row.id == "m9"));
}

#[test]
fn room_frames_read_state_and_history_work_like_a_dog_chat() {
    let mut store = loaded();
    store.select("g1");
    assert_eq!(store.read_request(), Some(("g1".to_owned(), "tg1".to_owned(), true)));
    assert_eq!(store.read_request(), None);
    store.apply_frame(&Frame::parse(r#"{"kind":"group","group":{"id":"g1","threadId":"tg1","name":"Pack","memberIds":["a","b","c"],"unread":false,"working":true,"work":{"kind":"working"}}}"#).unwrap());
    assert!(!store.view().rooms.iter().find(|room| room.id == "g1").unwrap().unread);
    assert_eq!(store.view().rooms.iter().find(|room| room.id == "g1").unwrap().preview, "The dogs are working\u{2026}");
    store.apply_frame(&Frame::parse(r#"{"kind":"message","threadId":"tg1","message":{"id":"m5","at":14,"role":"bot","kind":"text","text":"done","from":{"botId":"c","name":"Cy","color":"green"}}}"#).unwrap());
    assert_eq!(store.view().transcript.last().unwrap().text, "done");
    assert_eq!(store.older_request(), Some(("tg1".to_owned(), "m1".to_owned())));
    store.apply_older("tg1", parse::<ThreadPage>(r#"{"messages":[{"id":"m0","at":5,"role":"user","kind":"text","text":"earlier"}],"hasMore":false}"#).unwrap());
    assert_eq!(store.view().transcript[0].text, "earlier");
    assert!(!store.has_older("tg1"));
    store.apply_frame(&Frame::parse(r#"{"kind":"group.deleted","groupId":"g1"}"#).unwrap());
    assert!(store.view().rooms.iter().all(|room| room.id != "g1"));
    assert_ne!(store.selected(), Some("g1"));
}

#[test]
fn the_room_hint_follows_the_default_responder() {
    let store = loaded();
    assert_eq!(store.room_hint_for("g2").as_deref(), Some("Ash responds by default \u{2014} @mention someone else to choose them instead."));
    assert_eq!(store.room_hint_for("dm").as_deref(), Some("Reply here to continue the dog-to-dog conversation."));
}
