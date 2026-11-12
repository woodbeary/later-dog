use laterdog_core::outbox::{
    hold_delay, parse_saved, send_outcome, Failure, Item, Outbox, Outcome, Settled, Target, HOLD_CAP_MS, MAX_SERVER_FAILURES,
};

fn to_dog(send_id: &str, thread_id: &str, queued_at: u64) -> Item {
    Item {
        send_id: send_id.into(),
        thread_id: thread_id.into(),
        target: Target::Bot { bot_id: "dog-1".into(), deliver: None },
        text: format!("words of {send_id}"),
        reply_to_id: None,
        queued_at,
    }
}

fn status(code: u16) -> Failure {
    Failure::Status { code, retry_after_ms: None }
}

#[test]
fn a_sleeping_or_unreachable_home_holds_the_message() {
    for failure in [Failure::Network, Failure::Timeout, status(502), status(503), status(504), status(408), status(429)] {
        assert_eq!(send_outcome(&failure), Outcome::Hold { after_ms: None }, "{failure:?}");
    }
    assert_eq!(send_outcome(&Failure::Waking { retry_after_ms: Some(4_000) }), Outcome::Hold { after_ms: Some(4_000) });
    assert_eq!(send_outcome(&Failure::Waking { retry_after_ms: Some(0) }), Outcome::Hold { after_ms: None });
}

#[test]
fn a_server_fault_retries_and_a_refusal_is_final() {
    assert_eq!(send_outcome(&status(500)), Outcome::Retry);
    assert_eq!(send_outcome(&status(507)), Outcome::Retry);
    for code in [400, 401, 403, 404, 409, 413] {
        assert_eq!(send_outcome(&status(code)), Outcome::Final, "{code}");
    }
    assert_eq!(send_outcome(&Failure::Unreadable), Outcome::Final);
}

#[test]
fn the_wait_between_tries_doubles_up_to_fifteen_seconds() {
    assert_eq!([1, 2, 3, 4, 5, 40].map(hold_delay), [2_000, 4_000, 8_000, HOLD_CAP_MS, HOLD_CAP_MS, HOLD_CAP_MS]);
    assert_eq!(hold_delay(0), 2_000);
}

#[test]
fn one_thread_sends_in_order_and_threads_do_not_wait_on_each_other() {
    let mut outbox = Outbox::new();
    assert!(outbox.enqueue(to_dog("a1", "thread-a", 1)));
    assert!(outbox.enqueue(to_dog("a2", "thread-a", 2)));
    assert!(outbox.enqueue(to_dog("b1", "thread-b", 3)));

    let first: Vec<String> = outbox.due(10).into_iter().map(|item| item.send_id).collect();
    assert_eq!(first, ["a1", "b1"]);
    assert!(outbox.due(10).is_empty());

    outbox.delivered("a1");
    let next: Vec<String> = outbox.due(11).into_iter().map(|item| item.send_id).collect();
    assert_eq!(next, ["a2"]);
}

#[test]
fn the_same_send_is_never_queued_twice() {
    let mut outbox = Outbox::new();
    assert!(outbox.enqueue(to_dog("a1", "thread-a", 1)));
    assert!(!outbox.enqueue(to_dog("a1", "thread-a", 2)));
    assert_eq!(outbox.items().len(), 1);
}

#[test]
fn a_held_message_keeps_its_words_and_tries_again_without_limit() {
    let mut outbox = Outbox::new();
    outbox.enqueue(to_dog("a1", "thread-a", 1));
    let mut now = 0;
    for attempt in 1..=12 {
        assert_eq!(outbox.due(now).len(), 1, "attempt {attempt}");
        let Settled::Held { item, until_ms } = outbox.failed("a1", &Failure::Network, now) else {
            panic!("attempt {attempt} was not held");
        };
        assert_eq!(item.text, "words of a1");
        assert_eq!(until_ms, now + hold_delay(attempt));
        assert!(outbox.due(until_ms - 1).is_empty());
        assert_eq!(outbox.next_wake_ms(), Some(until_ms));
        now = until_ms;
    }
    assert!(outbox.holds("a1"));
}

#[test]
fn the_home_can_say_when_to_try_again() {
    let mut outbox = Outbox::new();
    outbox.enqueue(to_dog("a1", "thread-a", 1));
    outbox.due(100);
    let settled = outbox.failed("a1", &Failure::Waking { retry_after_ms: Some(700) }, 100);
    assert!(matches!(settled, Settled::Held { until_ms: 800, .. }));
}

#[test]
fn a_server_fault_gives_up_on_the_fifth_failure_and_hands_the_words_back() {
    let mut outbox = Outbox::new();
    outbox.enqueue(to_dog("a1", "thread-a", 1));
    outbox.enqueue(to_dog("a2", "thread-a", 2));
    let mut now = 0;
    for failure in 1..MAX_SERVER_FAILURES {
        outbox.due(now);
        let Settled::Held { until_ms, .. } = outbox.failed("a1", &status(500), now) else {
            panic!("failure {failure} was not retried");
        };
        now = until_ms;
    }
    outbox.due(now);
    let settled = outbox.failed("a1", &status(500), now);
    assert_eq!(settled, Settled::Final { item: to_dog("a1", "thread-a", 1) });
    assert!(!outbox.holds("a1"));

    let next: Vec<String> = outbox.due(now).into_iter().map(|item| item.send_id).collect();
    assert_eq!(next, ["a2"]);
}

#[test]
fn a_refusal_is_final_at_once_and_the_next_message_starts_fresh() {
    let mut outbox = Outbox::new();
    outbox.enqueue(to_dog("a1", "thread-a", 1));
    outbox.enqueue(to_dog("a2", "thread-a", 2));
    outbox.due(0);
    assert!(matches!(outbox.failed("a1", &status(403), 0), Settled::Final { .. }));
    outbox.due(0);
    assert!(matches!(outbox.failed("a2", &Failure::Network, 0), Settled::Held { until_ms: 2_000, .. }));
}

#[test]
fn a_message_the_home_already_has_is_let_go_even_mid_attempt() {
    let mut outbox = Outbox::new();
    outbox.enqueue(to_dog("a1", "thread-a", 1));
    outbox.enqueue(to_dog("a2", "thread-a", 2));
    outbox.due(0);
    assert!(outbox.acknowledge("a1"));
    assert!(outbox.due(0).is_empty());
    assert_eq!(outbox.failed("a1", &Failure::Network, 0), Settled::Gone);
    let next: Vec<String> = outbox.due(0).into_iter().map(|item| item.send_id).collect();
    assert_eq!(next, ["a2"]);
    assert!(!outbox.acknowledge("a1"));
}

#[test]
fn letting_go_of_a_waiting_message_leaves_the_one_in_flight_alone() {
    let mut outbox = Outbox::new();
    outbox.enqueue(to_dog("a1", "thread-a", 1));
    outbox.enqueue(to_dog("a2", "thread-a", 2));
    outbox.due(0);
    assert!(outbox.acknowledge("a2"));
    assert!(matches!(outbox.failed("a1", &Failure::Timeout, 0), Settled::Held { .. }));
    assert_eq!(outbox.items(), [to_dog("a1", "thread-a", 1)]);
}

#[test]
fn a_restart_brings_back_every_waiting_message_in_the_order_sent() {
    let mut outbox = Outbox::new();
    outbox.enqueue(Item { reply_to_id: Some("m9".into()), ..to_dog("a2", "thread-a", 20) });
    outbox.enqueue(Item {
        target: Target::Group { group_id: "pack".into() },
        ..to_dog("g1", "thread-g", 5)
    });
    outbox.enqueue(Item {
        target: Target::Bot { bot_id: "dog-1".into(), deliver: Some("now".into()) },
        ..to_dog("a1", "thread-a", 10)
    });
    let saved = outbox.saved().expect("something to save");

    let mut reopened = Outbox::new();
    reopened.restore(parse_saved(&saved));
    assert_eq!(reopened.items(), outbox.items());
    let first: Vec<String> = reopened.due(0).into_iter().map(|item| item.send_id).collect();
    assert_eq!(first, ["g1", "a1"]);
}

#[test]
fn the_saved_form_is_the_one_the_desktop_app_writes() {
    let saved = r#"{"version":1,"items":[
        {"sendId":"s1","threadId":"t1","target":{"kind":"bot","botId":"b1","deliver":"queue"},"text":"hello","replyToId":"m1","queuedAt":7,"recovery":{"draftId":"d1","text":"hello"}},
        {"sendId":"s2","threadId":"t2","target":{"kind":"group","groupId":"g1"},"text":"","queuedAt":8}
    ]}"#;
    let items = parse_saved(saved);
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].target, Target::Bot { bot_id: "b1".into(), deliver: Some("queue".into()) });
    assert_eq!(items[0].reply_to_id.as_deref(), Some("m1"));
    assert_eq!(items[1].target, Target::Group { group_id: "g1".into() });
}

#[test]
fn damaged_or_foreign_saves_are_ignored_rather_than_guessed_at() {
    assert!(parse_saved("").is_empty());
    assert!(parse_saved("not json").is_empty());
    assert!(parse_saved(r#"{"version":2,"items":[]}"#).is_empty());
    let mixed = r#"{"version":1,"items":[
        {"sendId":"","threadId":"t","target":{"kind":"bot","botId":"b"},"text":"x","queuedAt":1},
        {"sendId":"s","threadId":"t","target":{"kind":"room","id":"r"},"text":"x","queuedAt":1},
        {"sendId":"ok","threadId":"t","target":{"kind":"bot","botId":"b"},"text":"x","queuedAt":1}
    ]}"#;
    let kept: Vec<String> = parse_saved(mixed).into_iter().map(|item| item.send_id).collect();
    assert_eq!(kept, ["ok"]);
    assert_eq!(Outbox::new().saved(), None);
}
