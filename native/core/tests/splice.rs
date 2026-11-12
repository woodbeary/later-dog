use laterdog_core::splice::{splice, Splice};

#[test]
fn nothing_changed_touches_nothing() {
    assert_eq!(splice(&[1, 2, 3], &[1, 2, 3]), Splice::Nothing);
    assert_eq!(splice::<u8>(&[], &[]), Splice::Nothing);
}

#[test]
fn a_streaming_reply_reloads_only_its_own_row() {
    let old = ["day", "hello", "he"];
    let new = ["day", "hello", "hello th"];
    assert_eq!(splice(&old, &new), Splice::Rows(vec![2]));
}

#[test]
fn new_messages_are_appended_even_when_the_last_row_also_changed() {
    assert_eq!(splice(&["a", "b", "c"], &["a", "b", "c", "d"]), Splice::Append { from: 3, changed: vec![] });
    assert_eq!(splice(&["a", "b", "c"], &["a", "b", "C", "d", "e"]), Splice::Append { from: 3, changed: vec![2] });
    assert_eq!(splice(&["a", "b", "c", "d"], &["A", "b", "c", "d", "e"]), Splice::Reload);
}

#[test]
fn older_history_is_prepended_and_may_drop_the_old_first_day_line() {
    assert_eq!(splice(&["c", "d"], &["a", "b", "c", "d"]), Splice::Prepend { removed: 0, added: 2 });
    assert_eq!(splice(&["day", "c", "d"], &["day", "a", "b", "c", "d"]), Splice::Prepend { removed: 1, added: 3 });
}

#[test]
fn anything_else_reloads() {
    assert_eq!(splice(&["a", "b"], &["x", "y"]), Splice::Reload);
    assert_eq!(splice(&["a", "b", "c"], &["a", "c"]), Splice::Reload);
    assert_eq!(splice(&[], &["a"]), Splice::Reload);
}
