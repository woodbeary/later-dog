use laterdog_core::events::{retry_delay, Decoder, Frame, RETRY_MAX_MS};

const MESSAGE: &str = r#"{"kind":"message","threadId":"t1","message":{"id":"m1","at":5,"role":"bot","kind":"text","text":"hi"},"seq":43}"#;

fn message_frame(text: &str) -> Frame {
    Frame::parse(&MESSAGE.replace("\"hi\"", &format!("{text:?}"))).expect("a message frame")
}

#[test]
fn the_first_frame_says_hello_with_its_cursor() {
    let mut decoder = Decoder::new();
    let frames = decoder.feed(b"data: {\"kind\":\"hello\",\"cursor\":\"a4:41\",\"resumed\":false}\n\n");
    assert_eq!(frames, [Frame::Hello { cursor: Some("a4:41".into()), resumed: false }]);
}

#[test]
fn a_frame_split_across_any_chunk_boundary_arrives_once() {
    let wire = format!("id: s:43\ndata: {MESSAGE}\n\n");
    for split in 0..=wire.len() {
        let mut decoder = Decoder::new();
        let mut frames = decoder.feed(&wire.as_bytes()[..split]);
        frames.extend(decoder.feed(&wire.as_bytes()[split..]));
        assert_eq!(frames, [message_frame("hi")], "split at {split}");
        assert_eq!(decoder.last_event_id(), Some("s:43"));
    }
}

#[test]
fn carriage_return_line_endings_work_even_when_split_between_cr_and_lf() {
    let mut decoder = Decoder::new();
    let mut frames = decoder.feed(format!("data: {MESSAGE}\r").as_bytes());
    frames.extend(decoder.feed(b"\n\r"));
    frames.extend(decoder.feed(b"\ndata: {\"kind\":\"ping\"}\r\r"));
    assert_eq!(frames, [message_frame("hi"), Frame::Ping]);
}

#[test]
fn several_data_lines_join_with_newlines() {
    let mut decoder = Decoder::new();
    let frames = decoder.feed(b"data: {\"kind\":\"message\",\"threadId\":\"t1\",\ndata: \"message\":{\"id\":\"m1\",\"at\":5,\"role\":\"bot\",\"kind\":\"text\",\"text\":\"hi\"}}\n\n");
    assert_eq!(frames, [message_frame("hi")]);
}

#[test]
fn comments_and_heartbeats_are_quiet_and_pings_are_frames() {
    let mut decoder = Decoder::new();
    let frames = decoder.feed(b": keepalive\n\ndata: {\"kind\":\"ping\"}\n\n:\n\n");
    assert_eq!(frames, [Frame::Ping]);
}

#[test]
fn a_leading_byte_order_mark_is_ignored() {
    let mut decoder = Decoder::new();
    let frames = decoder.feed("\u{feff}data: {\"kind\":\"ping\"}\n\n".as_bytes());
    assert_eq!(frames, [Frame::Ping]);
}

#[test]
fn unknown_kinds_and_broken_json_are_safe() {
    let mut decoder = Decoder::new();
    let frames = decoder.feed(b"data: {\"kind\":\"routine\",\"routine\":{}}\n\ndata: not json\n\ndata: [1]\n\ndata: {\"kind\":\"message\",\"threadId\":\"t1\"}\n\n");
    assert_eq!(frames, [Frame::Other { kind: "routine".into() }, Frame::Other { kind: "message".into() }]);
}

#[test]
fn named_events_other_than_message_are_skipped() {
    let mut decoder = Decoder::new();
    let frames = decoder.feed(b"event: other\ndata: {\"kind\":\"ping\"}\n\nevent: message\ndata: {\"kind\":\"ping\"}\n\n");
    assert_eq!(frames, [Frame::Ping]);
}

#[test]
fn a_line_without_a_colon_or_space_still_parses() {
    let mut decoder = Decoder::new();
    let frames = decoder.feed(b"data:{\"kind\":\"ping\"}\nretry: 10\nunknown\n\n");
    assert_eq!(frames, [Frame::Ping]);
}

#[test]
fn text_split_inside_a_multibyte_character_survives() {
    let wire = format!("data: {}\n\n", MESSAGE.replace("\"hi\"", "\"h\u{e9}llo \u{1f415}\""));
    let bytes = wire.as_bytes();
    let dog = wire.find('\u{1f415}').expect("dog") + 2;
    let mut decoder = Decoder::new();
    let mut frames = decoder.feed(&bytes[..dog]);
    frames.extend(decoder.feed(&bytes[dog..]));
    assert_eq!(frames, [message_frame("h\u{e9}llo \u{1f415}")]);
}

#[test]
fn a_new_connection_drops_a_half_read_frame() {
    let mut decoder = Decoder::new();
    assert!(decoder.feed(b"data: {\"kind\":\"pi").is_empty());
    decoder.reset_connection();
    assert_eq!(decoder.feed(b"data: {\"kind\":\"ping\"}\n\n"), [Frame::Ping]);
}

#[test]
fn bot_frames_carry_only_what_changed() {
    let frame = Frame::parse(r#"{"kind":"bot","bot":{"id":"b1","name":"Scout","activity":"working","busy":true,"unread":false,"extra":{"x":1}}}"#);
    let Some(Frame::Bot { bot }) = frame else { panic!("not a bot frame: {frame:?}") };
    assert_eq!((bot.id.as_str(), bot.name.as_deref(), bot.activity.as_deref(), bot.busy), ("b1", Some("Scout"), Some("working"), Some(true)));
    assert_eq!(bot.thread_id, None);
    assert_eq!(bot.messages, None);
}

#[test]
fn reconnecting_waits_half_a_second_then_doubles_to_ten() {
    assert_eq!([0, 1, 2, 3, 4, 5, 6, 40].map(retry_delay), [500, 1_000, 2_000, 4_000, 8_000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
}
