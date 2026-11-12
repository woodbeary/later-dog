use laterdog_core::cards::{self, Behavior, ButtonLook, RespondFailure};
use laterdog_core::events::Frame;
use laterdog_core::outbox::{Failure, Target};
use laterdog_core::store::{Answered, CardAction, CardLine, FoldIcon, QuestionFooter, QuestionStep, RowKind, SendState, Store};
use laterdog_core::wire::{parse, BotsPage, SendReceipt, WireCard};

const PAGE: &str = r#"{
  "bots": [
    {"id":"j","threadId":"tj","name":"Juniper","color":"red","alwaysAllow":["Read"],"messages":[
      {"id":"m1","at":1,"role":"bot","kind":"text","text":"Pick one"},
      {"id":"c1","at":2,"role":"bot","kind":"options","card":{"title":"Which color?","subtitle":"For the logo","options":["Red","Blue",{"label":"Green"},"Red"]}},
      {"id":"q1","at":3,"role":"bot","kind":"options","card":{"title":"","subtitle":"","options":[],"requestId":"r-q1","requestType":"question","questionRequest":{"version":1,"questions":[{"question":"Ship today?","options":[{"label":"Yes"},{"label":"No"}]}]}}},
      {"id":"a1","at":4,"role":"bot","kind":"options","card":{"title":"Bash","subtitle":"rm -rf build","options":["Allow","Deny"],"requestId":"r-a1","tool":"Bash","allowKey":"Bash(rm:*)"}}
    ]}
  ],
  "groups": [
    {"id":"g","threadId":"tg","name":"Pack","memberIds":["j"],"unread":false,"working":false,"messages":[
      {"id":"gc","at":5,"role":"bot","kind":"options","from":{"botId":"j","name":"Juniper","color":"red"},"card":{"title":"Lunch?","subtitle":"","options":["Tacos","Soup"]}}
    ]}
  ],
  "sections": []
}"#;

fn loaded() -> Store {
    let mut store = Store::new([3; 16]);
    store.apply_page(parse::<BotsPage>(PAGE).expect("the page parses"));
    store
}

fn card_rows(store: &Store) -> Vec<CardLine> {
    store.view().transcript.into_iter().filter(|row| row.kind == RowKind::Card).filter_map(|row| row.card).collect()
}

fn card(store: &Store, id: &str) -> Option<CardLine> {
    store.view().transcript.into_iter().find(|row| row.id == id).and_then(|row| row.card)
}

fn frame(raw: &str) -> Frame {
    Frame::parse(raw).expect("a frame")
}

#[test]
fn an_options_card_shows_its_title_subtitle_and_lettered_choices() {
    let store = loaded();
    let Some(CardLine::Options { title, subtitle, choices, custom, dismiss, error, .. }) = card(&store, "c1") else { panic!("an open options card") };
    assert_eq!(title, "Which color?");
    assert_eq!(subtitle, "For the logo");
    assert_eq!(choices, ["Red", "Blue", "Green"]);
    assert!(custom && dismiss && error.is_none());
    assert_eq!(card_rows(&store).len(), 3);
}

#[test]
fn answering_an_options_card_goes_through_the_outbox_with_the_card_and_marks_it_on_delivery() {
    let mut store = loaded();
    let CardAction::Send(item) = store.answer_card("c1", " Blue ", 10) else { panic!("an outbox send") };
    assert_eq!(item.text, "Blue");
    assert_eq!(item.target, Target::Bot { bot_id: "j".into(), deliver: None });
    let reference = item.card.clone().expect("the card travels with the send");
    assert_eq!((reference.bot_id.as_str(), reference.message_id.as_str(), reference.group_id), ("j", "c1", None));
    assert!(card(&store, "c1").is_none(), "the answer line takes the card's place");
    let mine = store.view().transcript.into_iter().find(|row| row.mine).expect("the answer shows as yours");
    assert_eq!((mine.text.as_str(), mine.status), ("Blue", Some(SendState::Sending.words())));
    assert_eq!(store.answer_card("c1", "Red", 11), CardAction::Nothing, "one answer at a time");
    assert_eq!(store.due(10).len(), 1);

    store.send_succeeded(&item.send_id, SendReceipt::default());
    let patches = store.take_patches();
    assert_eq!(patches.len(), 1);
    assert_eq!(patches[0].path, "/api/bots/j/cards/c1");
    assert_eq!(patches[0].body, serde_json::json!({ "answered": "Blue", "dismissed": true }));
    assert!(card(&store, "c1").is_none());
    assert!(store.take_patches().is_empty());
}

#[test]
fn a_held_card_answer_waits_like_a_held_message() {
    let mut store = loaded();
    let CardAction::Send(item) = store.answer_card("c1", "Red", 10) else { panic!() };
    store.due(10);
    store.send_failed(&item.send_id, &Failure::Waking { retry_after_ms: None }, 10);
    assert_eq!(store.send_state(&item.send_id), Some(SendState::Held));
    assert!(card(&store, "c1").is_none());
    assert!(store.take_patches().is_empty());
}

#[test]
fn a_refused_card_answer_reopens_the_card_and_keeps_the_answer_under_not_sent() {
    let mut store = loaded();
    let CardAction::Send(item) = store.answer_card("c1", "Red", 10) else { panic!() };
    store.due(10);
    store.send_failed(&item.send_id, &Failure::Status { code: 400, retry_after_ms: None }, 10);
    assert!(matches!(card(&store, "c1"), Some(CardLine::Options { .. })), "answerable again");
    let mine = store.view().transcript.into_iter().find(|row| row.mine).expect("the answer stays");
    assert_eq!((mine.text.as_str(), mine.status), ("Red", Some(SendState::NotSent.words())));
    assert!(store.send_again(&item.send_id).is_some());
    assert!(card(&store, "c1").is_none());
}

#[test]
fn a_card_answer_restored_after_a_restart_still_marks_the_card_on_delivery() {
    let mut store = loaded();
    let CardAction::Send(item) = store.answer_card("c1", "Green", 10) else { panic!() };
    let saved = store.saved_outbox().expect("saved");
    assert!(saved.contains("\"messageId\":\"c1\""));

    let mut reopened = Store::new([4; 16]);
    assert_eq!(reopened.restore_outbox(&saved), 1);
    reopened.apply_page(parse::<BotsPage>(PAGE).unwrap());
    assert!(card(&reopened, "c1").is_none(), "the waiting answer still covers the card");
    let due = reopened.due(20);
    assert_eq!(due[0].send_id, item.send_id);
    reopened.send_succeeded(&item.send_id, SendReceipt::default());
    let patches = reopened.take_patches();
    assert_eq!(patches[0].path, "/api/bots/j/cards/c1");
    assert_eq!(patches[0].body["answered"], "Green");
}

#[test]
fn dismissing_an_options_card_hides_it_and_saves_that_at_the_home() {
    let mut store = loaded();
    let CardAction::Patch(patch) = store.dismiss_card("c1") else { panic!("a patch") };
    assert_eq!(patch.path, "/api/bots/j/cards/c1");
    assert_eq!(patch.body, serde_json::json!({ "dismissed": true }));
    assert!(card(&store, "c1").is_none());
}

#[test]
fn a_later_message_from_the_person_retires_an_options_card() {
    let mut store = loaded();
    store.apply_frame(&frame(r#"{"kind":"message","threadId":"tj","message":{"id":"u9","at":9,"role":"user","kind":"text","text":"never mind"}}"#));
    assert!(card(&store, "c1").is_none());
}

#[test]
fn a_room_card_reads_sending_until_the_home_takes_it_then_is_saved_as_answered() {
    let mut store = loaded();
    assert!(store.select("g"));
    let CardAction::Send(item) = store.answer_card("gc", "Soup", 10) else { panic!() };
    assert_eq!(item.target, Target::Group { group_id: "g".into() });
    assert_eq!(item.thread_id, "tg");
    let Some(CardLine::Folded { icon, summary, .. }) = card(&store, "gc") else { panic!("a folded line") };
    assert_eq!((icon, summary.as_str()), (FoldIcon::Sending, "Sending\u{2026} Soup"));
    store.send_succeeded(&item.send_id, SendReceipt::default());
    let patches = store.take_patches();
    assert_eq!(patches[0].path, "/api/groups/g/cards/gc");
    assert_eq!(patches[0].body, serde_json::json!({ "answered": "Soup", "dismissed": true, "threadId": "tg" }));
    assert!(card(&store, "gc").is_none());
}

#[test]
fn a_question_answers_through_the_respond_route_and_folds_to_the_answer() {
    let mut store = loaded();
    let Some(CardLine::Question { title, options, footer, step, .. }) = card(&store, "q1") else { panic!("a question") };
    assert_eq!(title, "Juniper has a question");
    assert_eq!(options.iter().map(|option| (option.letter.as_str(), option.label.as_str())).collect::<Vec<_>>(), [("A", "Yes"), ("B", "No")]);
    assert_eq!(footer, QuestionFooter::None);
    assert!(step.is_none());
    let CardAction::Respond(respond) = store.question("q1", QuestionStep::Choose(0), 5) else { panic!("a respond") };
    assert_eq!(respond.thread_id, "tj");
    assert_eq!(respond.body, serde_json::json!({ "requestId": "r-q1", "behavior": "answer", "message": "The person answered your questions.\n\nQ: Ship today?\nA: Yes" }));
    let Some(CardLine::Folded { summary, icon, label, .. }) = card(&store, "q1") else { panic!() };
    assert_eq!((summary.as_str(), icon, label.as_str()), ("Yes", FoldIcon::Check, "You answered: Yes"));
    assert_eq!(store.question("q1", QuestionStep::Choose(1), 6), CardAction::Nothing);
    store.responded("r-q1", Ok(()));
    assert_eq!(store.answering("r-q1"), Some(&Answered::Sent));
}

#[test]
fn a_question_answer_that_fails_reopens_with_a_plain_sentence() {
    let mut store = loaded();
    store.question("q1", QuestionStep::Choose(1), 5);
    store.responded("r-q1", Err(RespondFailure::Network));
    let Some(CardLine::Question { error, .. }) = card(&store, "q1") else { panic!("open again") };
    assert_eq!(error.as_deref(), Some(cards::UNREACHABLE_MESSAGE));
    assert!(matches!(store.question("q1", QuestionStep::Choose(0), 6), CardAction::Respond(_)));
}

#[test]
fn other_and_several_choices_wait_for_submit() {
    let mut store = loaded();
    store.question("q1", QuestionStep::Other, 5);
    let Some(CardLine::Question { other, footer, .. }) = card(&store, "q1") else { panic!() };
    assert!(other);
    assert_eq!(footer, QuestionFooter::Submit { enabled: false });
    store.question("q1", QuestionStep::Type("Tomorrow".into()), 5);
    let Some(CardLine::Question { footer, custom, .. }) = card(&store, "q1") else { panic!() };
    assert_eq!((footer, custom.as_str()), (QuestionFooter::Submit { enabled: true }, "Tomorrow"));
    let CardAction::Respond(respond) = store.question("q1", QuestionStep::Enter, 5) else { panic!() };
    assert_eq!(respond.body["message"], "The person answered your questions.\n\nQ: Ship today?\nA: Tomorrow");
}

#[test]
fn several_questions_step_through_and_submit_together() {
    let mut store = Store::new([1; 16]);
    store.apply_page(parse::<BotsPage>(r#"{"bots":[{"id":"d","threadId":"td","name":"Dot","messages":[
      {"id":"q","at":1,"role":"bot","kind":"options","card":{"title":"","subtitle":"","options":[],"requestId":"r","questionRequest":{"questions":[
        {"question":"Size?","header":"Size","options":[{"label":"S"},{"label":"L"}]},
        {"question":"Toppings?","multiSelect":true,"options":[{"label":"Cheese"},{"label":"Olives"}]}]}}}]}]}"#).unwrap());
    let Some(CardLine::Question { step, tabs, footer, .. }) = card(&store, "q") else { panic!() };
    assert_eq!(step.as_deref(), Some("1 of 2"));
    assert_eq!(tabs.iter().map(|tab| tab.label.as_str()).collect::<Vec<_>>(), ["Size", "Question 2"]);
    assert_eq!(footer, QuestionFooter::Steps { back: false, next: "Next", next_enabled: false, last: false });
    assert_eq!(store.question("q", QuestionStep::Choose(1), 1), CardAction::Nothing);
    let Some(CardLine::Question { step, multi, footer, .. }) = card(&store, "q") else { panic!() };
    assert_eq!((step.as_deref(), multi), (Some("2 of 2"), true));
    assert_eq!(footer, QuestionFooter::Steps { back: true, next: "Submit answers", next_enabled: false, last: true });
    store.question("q", QuestionStep::Choose(0), 1);
    store.question("q", QuestionStep::Choose(1), 1);
    let CardAction::Respond(respond) = store.question("q", QuestionStep::Submit, 1) else { panic!() };
    assert_eq!(respond.body["message"], "The person answered your questions.\n\nQ: Size?\nA: L\n\nQ: Toppings?\nA: Cheese, Olives");
    let Some(CardLine::Folded { summary, .. }) = card(&store, "q") else { panic!() };
    assert_eq!(summary, "L \u{b7} Cheese, Olives");
}

#[test]
fn closing_a_question_tells_the_dog_and_hides_the_card_unless_it_fails() {
    let mut store = loaded();
    let CardAction::Respond(respond) = store.dismiss_card("q1") else { panic!() };
    assert_eq!(respond.body["dismiss"], true);
    assert_eq!(respond.body["message"], cards::QUESTION_DISMISS_MESSAGE);
    assert!(card(&store, "q1").is_none());
    store.responded("r-q1", Err(RespondFailure::Status { code: 503, said: None }));
    let Some(CardLine::Question { error, .. }) = card(&store, "q1") else { panic!() };
    assert_eq!(error.as_deref(), Some("later.dog isn't answering right now. Check that it's running, then try again."));
}

#[test]
fn a_waiting_approval_is_a_quiet_line_with_its_buttons_above_the_composer() {
    let store = loaded();
    let Some(CardLine::Waiting { line, note }) = card(&store, "a1") else { panic!("a waiting line") };
    assert_eq!((line.as_str(), note), ("Juniper wants to run a command", "Waiting for your answer below"));
    let panel = store.view().approval.expect("a panel");
    assert_eq!(panel.label, "Let Juniper run a command?");
    assert_eq!(panel.detail, "rm -rf build");
    let labels: Vec<(&str, ButtonLook)> = panel.decisions.iter().map(|decision| (decision.label.as_str(), decision.look)).collect();
    assert_eq!(labels, [("Allow once", ButtonLook::Primary), ("Don't allow", ButtonLook::Quiet), ("Always allow", ButtonLook::Durable)]);
    assert_eq!(panel.reach.as_deref(), Some("Always allow lets Juniper do this again without asking in group chats and in new chats."));
    assert!(!panel.sending && panel.error.is_none());
}

#[test]
fn approval_answers_use_the_respond_route_with_the_renderer_scopes() {
    let mut store = loaded();
    let CardAction::Respond(respond) = store.decide("a1", 0) else { panic!() };
    assert_eq!(respond.body, serde_json::json!({ "requestId": "r-a1", "behavior": "allow", "scope": "once" }));
    assert!(respond.grant.is_none());
    assert!(store.view().approval.unwrap().sending);
    assert_eq!(store.decide("a1", 1), CardAction::Nothing, "one answer at a time");
    store.responded("r-a1", Err(RespondFailure::Status { code: 409, said: Some("This request is no longer waiting.".into()) }));
    let panel = store.view().approval.unwrap();
    assert_eq!((panel.sending, panel.error.as_deref()), (false, Some("This request is no longer waiting.")));

    let CardAction::Respond(deny) = store.decide("a1", 1) else { panic!() };
    assert_eq!(deny.body, serde_json::json!({ "requestId": "r-a1", "behavior": "deny", "message": "Declined." }));
    store.responded("r-a1", Err(RespondFailure::Timeout));
    let CardAction::Respond(always) = store.decide("a1", 2) else { panic!() };
    assert_eq!(always.body["scope"], "always");
    assert_eq!(always.body_without_grant.as_ref().unwrap()["scope"], "once");
    let grant = always.grant.expect("the grant is saved first");
    assert_eq!((grant.path.as_str(), grant.method), ("/api/bots/j", "PATCH"));
    assert_eq!(grant.body, serde_json::json!({ "alwaysAllow": ["Read", "Bash(rm:*)"] }));
}

#[test]
fn a_settled_approval_folds_to_its_outcome_and_the_panel_goes_away() {
    let mut store = loaded();
    store.apply_frame(&frame(r#"{"kind":"message.patch","threadId":"tj","message":{"id":"a1","at":4,"role":"bot","kind":"options","card":{"title":"Bash","subtitle":"rm -rf build","options":[],"requestId":"r-a1","tool":"Bash","answered":"allow","answerScope":"once"}}}"#));
    let Some(CardLine::Folded { icon, summary, trailing, centered, .. }) = card(&store, "a1") else { panic!() };
    assert_eq!((icon, summary.as_str(), trailing.as_deref(), centered), (FoldIcon::Check, "Allowed once", Some("Run a command"), true));
    assert!(store.view().approval.is_none());
}

fn wire(raw: &str) -> WireCard {
    serde_json::from_str(raw).expect("a card")
}

#[test]
fn approval_outcomes_and_buttons_follow_the_renderer_rules() {
    assert_eq!(cards::approval_outcome(&wire(r#"{"tool":"Bash","requestId":"r","expired":true}"#)).as_deref(), Some("No answer in time, so this didn't happen"));
    assert_eq!(cards::approval_outcome(&wire(r#"{"tool":"Bash","requestId":"r","answered":"deny"}"#)).as_deref(), Some("Denied"));
    assert_eq!(cards::approval_outcome(&wire(r#"{"tool":"Bash","requestId":"r","answered":"resolved"}"#)).as_deref(), Some("Resolved externally"));
    assert_eq!(cards::approval_outcome(&wire(r#"{"tool":"Bash","requestId":"r","answered":"allow","answerScope":"always"}"#)).as_deref(), Some("Always allowed"));
    let session = cards::decisions(&wire(r#"{"tool":"Edit","requestId":"r","allowSession":true}"#), true);
    assert_eq!(session.iter().map(|decision| decision.label.as_str()).collect::<Vec<_>>(), ["Allow once", "Don't allow", "Allow for this chat"]);
    let chat = cards::respond_body("r", &session[2], &wire(r#"{"tool":"Edit","requestId":"r","allowSession":true}"#), true);
    assert_eq!(chat, serde_json::json!({ "requestId": "r", "behavior": "allow", "always": true, "scope": "chat" }));
    let mac = cards::decisions(&wire(r#"{"tool":"mac_run_command","requestId":"r","allowKey":"mac"}"#), true);
    assert_eq!(mac.iter().map(|decision| decision.label.as_str()).collect::<Vec<_>>(), ["Allow once", "Always allow", "Never"]);
    let never = cards::respond_body("r", &mac[2], &wire(r#"{"tool":"mac_run_command"}"#), true);
    assert_eq!((never["behavior"].clone(), never["scope"].clone()), (serde_json::json!(Behavior::Deny), serde_json::json!("never")));
    let send = cards::decisions(&wire(r#"{"tool":"mac_send_text","requestId":"r"}"#), true);
    assert_eq!(send.iter().map(|decision| decision.label.as_str()).collect::<Vec<_>>(), ["Send", "Don't send"]);
    assert_eq!(cards::tool_label(Some("mcp__github__create_issue"), None), "take an action");
    assert_eq!(cards::tool_label(Some("mcp__computer__screenshot"), Some("local-computer")), "use this Mac");
    assert_eq!(cards::tool_label(Some("open_door_now"), None), "open door now");
}

#[test]
fn plain_sentences_stand_in_for_bare_codes() {
    assert_eq!(cards::plain_error(&RespondFailure::Status { code: 500, said: Some("internal_error".into()) }), cards::GENERIC_MESSAGE);
    assert_eq!(cards::plain_error(&RespondFailure::Status { code: 404, said: None }), "That isn't there any more. Refresh and try again.");
    assert_eq!(cards::plain_error(&RespondFailure::Timeout), cards::TOO_SLOW_MESSAGE);
}
