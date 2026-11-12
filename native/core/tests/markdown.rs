use laterdog_core::markdown::{inlines, language_name, line_count, line_count_words, link_target, parse, plain, snippet_file_name, table_text, text, Block, Inline};

fn strong(children: Vec<Inline>) -> Inline {
    Inline::Strong { children }
}

fn em(children: Vec<Inline>) -> Inline {
    Inline::Emphasis { children }
}

fn code(words: &str) -> Inline {
    Inline::Code { text: words.to_owned() }
}

fn link(href: Option<&str>, children: Vec<Inline>) -> Inline {
    Inline::Link { href: href.map(str::to_owned), children }
}

fn para(content: Vec<Inline>) -> Block {
    Block::Paragraph { content }
}

#[test]
fn paragraphs_split_on_blank_lines_and_soft_breaks_read_as_spaces() {
    assert_eq!(parse("one\ntwo\n\nthree"), [para(vec![text("one two")]), para(vec![text("three")])]);
}

#[test]
fn two_trailing_spaces_or_a_backslash_break_the_line() {
    assert_eq!(parse("one  \ntwo\\\nthree"), [para(vec![text("one"), Inline::Break, text("two"), Inline::Break, text("three")])]);
}

#[test]
fn bold_italic_and_inline_code() {
    assert_eq!(
        inlines("a **b** and *c* and __d__ and _e_ and `f`"),
        [text("a "), strong(vec![text("b")]), text(" and "), em(vec![text("c")]), text(" and "), strong(vec![text("d")]), text(" and "), em(vec![text("e")]), text(" and "), code("f")]
    );
}

#[test]
fn emphasis_nests_both_ways() {
    assert_eq!(inlines("***both***"), [em(vec![strong(vec![text("both")])])]);
    assert_eq!(inlines("**bold *and italic* here**"), [strong(vec![text("bold "), em(vec![text("and italic")]), text(" here")])]);
    assert_eq!(inlines("*a **b** c*"), [em(vec![text("a "), strong(vec![text("b")]), text(" c")])]);
}

#[test]
fn unterminated_markers_stay_as_written() {
    assert_eq!(inlines("**not closed"), [text("**not closed")]);
    assert_eq!(inlines("a * b * c"), [text("a * b * c")]);
    assert_eq!(inlines("`open code"), [text("`open code")]);
    assert_eq!(inlines("[label](later.dog"), [text("[label](later.dog")]);
    assert_eq!(inlines("[label](https://later.dog"), [text("[label]("), link(Some("https://later.dog"), vec![text("https://later.dog")])]);
    assert_eq!(inlines("snake_case_name"), [text("snake_case_name")]);
}

#[test]
fn code_spans_keep_markers_and_html_literal() {
    assert_eq!(inlines("`**x** <b>`"), [code("**x** <b>")]);
    assert_eq!(inlines("`` a ` b ``"), [code("a ` b")]);
}

#[test]
fn raw_html_is_shown_as_text() {
    assert_eq!(inlines("<b>bold</b> <script>alert(1)</script>"), [text("<b>bold</b> <script>alert(1)</script>")]);
    assert_eq!(parse("<div>\nhi\n</div>"), [para(vec![text("<div> hi </div>")])]);
}

#[test]
fn links_open_only_web_and_mail_addresses() {
    assert_eq!(inlines("[site](https://later.dog)"), [link(Some("https://later.dog"), vec![text("site")])]);
    assert_eq!(inlines("[mail](mailto:hi@later.dog)"), [link(Some("mailto:hi@later.dog"), vec![text("mail")])]);
    assert_eq!(inlines("[bad](javascript:alert(1))"), [link(None, vec![text("bad")])]);
    assert_eq!(inlines("[file](/etc/passwd)"), [link(None, vec![text("file")])]);
    assert_eq!(inlines("[**bold** link](http://a.b \"title\")"), [link(Some("http://a.b"), vec![strong(vec![text("bold")]), text(" link")])]);
    assert_eq!(link_target("HTTPS://LATER.DOG"), Some("HTTPS://LATER.DOG".to_owned()));
    assert_eq!(link_target("https://"), None);
    assert_eq!(link_target("file:///tmp/x"), None);
}

#[test]
fn bare_and_angle_addresses_become_links() {
    assert_eq!(inlines("see https://later.dog/a_b."), [text("see "), link(Some("https://later.dog/a_b"), vec![text("https://later.dog/a_b")]), text(".")]);
    assert_eq!(inlines("(www.later.dog)"), [text("("), link(Some("http://www.later.dog"), vec![text("www.later.dog")]), text(")")]);
    assert_eq!(inlines("<https://later.dog>"), [link(Some("https://later.dog"), vec![text("https://later.dog")])]);
    assert_eq!(inlines("<hi@later.dog>"), [link(Some("mailto:hi@later.dog"), vec![text("hi@later.dog")])]);
    assert_eq!(inlines("<ftp://x.y>"), [link(None, vec![text("ftp://x.y")])]);
}

#[test]
fn escapes_and_entities() {
    assert_eq!(inlines("\\*not\\* &amp; &lt;b&gt; &#65;"), [text("*not* & <b> A")]);
}

#[test]
fn headings_atx_and_underlined() {
    assert_eq!(
        parse("# One\n## Two ##\n###### Six\n####### seven\nTitle\n===\nSub\n---"),
        [
            Block::Heading { level: 1, content: vec![text("One")] },
            Block::Heading { level: 2, content: vec![text("Two")] },
            Block::Heading { level: 6, content: vec![text("Six")] },
            Block::Heading { level: 1, content: vec![text("####### seven Title")] },
            Block::Heading { level: 2, content: vec![text("Sub")] },
        ]
    );
    assert_eq!(parse("#hashtag"), [para(vec![text("#hashtag")])]);
}

#[test]
fn fenced_code_keeps_its_text_and_language() {
    assert_eq!(
        parse("before\n```rust\nfn main() {\n    **not bold**\n}\n```\nafter"),
        [para(vec![text("before")]), Block::Code { language: "rust".into(), text: "fn main() {\n    **not bold**\n}".into() }, para(vec![text("after")])]
    );
    assert_eq!(parse("~~~\n<b>\n~~~"), [Block::Code { language: String::new(), text: "<b>".into() }]);
}

#[test]
fn an_unterminated_fence_runs_to_the_end_while_a_reply_streams() {
    assert_eq!(parse("```py\nprint(1)\n"), [Block::Code { language: "py".into(), text: "print(1)\n".into() }]);
    assert_eq!(parse("```"), [Block::Code { language: String::new(), text: String::new() }]);
}

#[test]
fn indented_code_blocks() {
    assert_eq!(parse("    let x = 1;\n\n    x\n"), [Block::Code { language: String::new(), text: "let x = 1;\n\nx".into() }]);
}

#[test]
fn unordered_and_ordered_lists_with_nesting() {
    let blocks = parse("- a\n- b **bold**\n  - inner\n  - inner two\n- c\n\n3. three\n4. four");
    assert_eq!(
        blocks,
        [
            Block::List {
                ordered: false,
                start: 0,
                items: vec![
                    vec![para(vec![text("a")])],
                    vec![
                        para(vec![text("b "), strong(vec![text("bold")])]),
                        Block::List { ordered: false, start: 0, items: vec![vec![para(vec![text("inner")])], vec![para(vec![text("inner two")])]] },
                    ],
                    vec![para(vec![text("c")])],
                ],
            },
            Block::List { ordered: true, start: 3, items: vec![vec![para(vec![text("three")])], vec![para(vec![text("four")])]] },
        ]
    );
}

#[test]
fn list_items_take_lazy_lines_and_a_new_marker_starts_a_new_list() {
    assert_eq!(
        parse("1. one\ncontinued\n2) two"),
        [
            Block::List { ordered: true, start: 1, items: vec![vec![para(vec![text("one continued")])]] },
            Block::List { ordered: true, start: 2, items: vec![vec![para(vec![text("two")])]] },
        ]
    );
}

#[test]
fn a_list_interrupts_a_paragraph_and_code_sits_inside_an_item() {
    assert_eq!(
        parse("Steps:\n- run\n\n  ```\n  make\n  ```"),
        [
            para(vec![text("Steps:")]),
            Block::List { ordered: false, start: 0, items: vec![vec![para(vec![text("run")]), Block::Code { language: String::new(), text: "make".into() }]] },
        ]
    );
}

#[test]
fn block_quotes_nest_and_hold_other_blocks() {
    assert_eq!(
        parse("> quoted\nlazy\n> > deeper\n> - item"),
        [Block::Quote {
            blocks: vec![
                para(vec![text("quoted lazy")]),
                Block::Quote { blocks: vec![para(vec![text("deeper")])] },
                Block::List { ordered: false, start: 0, items: vec![vec![para(vec![text("item")])]] },
            ],
        }]
    );
}

#[test]
fn rules_and_a_star_rule_is_not_a_list() {
    assert_eq!(parse("a\n\n* * *\n\n___"), [para(vec![text("a")]), Block::Rule, Block::Rule]);
}

#[test]
fn tables_fall_back_to_aligned_plain_text() {
    let blocks = parse("| Name | Breed |\n| --- | :-: |\n| **Biscuit** | Corgi |\n| Juniper |\nnext row\n\nafter");
    let rows = vec![vec!["Name".to_owned(), "Breed".to_owned()], vec!["Biscuit".to_owned(), "Corgi".to_owned()], vec!["Juniper".to_owned(), String::new()]];
    let mut with_next = rows.clone();
    with_next.push(vec!["next row".to_owned(), String::new()]);
    assert_eq!(blocks, [Block::Table { rows: with_next }, para(vec![text("after")])]);
    assert_eq!(table_text(&rows), "Name     Breed\n-------  -----\nBiscuit  Corgi\nJuniper");
    assert_eq!(parse("a | b\n- | -\n1 | 2"), [Block::Table { rows: vec![vec!["a".into(), "b".into()], vec!["1".into(), "2".into()]] }]);
}

#[test]
fn a_pipe_without_a_delimiter_row_is_just_text() {
    assert_eq!(parse("a | b\nc | d"), [para(vec![text("a | b c | d")])]);
}

#[test]
fn plain_text_reads_every_node() {
    let blocks = inlines("**a** *b* `c` [d](https://e.f)");
    assert_eq!(plain(&blocks), "a b c d");
}

#[test]
fn code_block_labels_read_like_the_desktop() {
    assert_eq!(language_name(""), "Code");
    assert_eq!(language_name("RS"), "Rust");
    assert_eq!(language_name("zig"), "Zig");
    assert_eq!(language_name("c++"), "C++");
    assert_eq!(snippet_file_name("python"), "snippet.py");
    assert_eq!(snippet_file_name("make"), "makefile");
    assert_eq!(snippet_file_name(""), "snippet.txt");
    assert_eq!(snippet_file_name("zig"), "snippet.zig");
    assert_eq!(snippet_file_name("a long name"), "snippet.txt");
    assert_eq!(line_count(""), 0);
    assert_eq!(line_count("a\nb"), 2);
    assert_eq!(line_count_words(1), "1 line");
    assert_eq!(line_count_words(3), "3 lines");
}

#[test]
fn nothing_panics_on_ragged_input() {
    for source in ["", "\n\n", "*", "**", "_*_*", "[", "[]", "[](", "![](", "<", "<a", "&", "&#;", "&#xZZ;", "|", "|\n|", "-", "1.", "> ", "```\n```\n```", "    ", "\u{1f436} **dog**", "a\r\nb\rc", "\t- tab"] {
        let _ = parse(source);
    }
}

#[test]
fn previews_read_as_one_plain_line() {
    assert_eq!(laterdog_core::markdown::preview("## Release notes\n\nHere is **what** changed."), "Release notes Here is what changed.");
    assert_eq!(laterdog_core::markdown::preview("3. a\n4. b"), "3. a 4. b");
    assert_eq!(laterdog_core::markdown::preview("```\nonly code\n```"), "only code");
    assert_eq!(laterdog_core::markdown::preview("text\n\n```\ncode\n```"), "text");
    assert_eq!(laterdog_core::markdown::preview("---\n> quoted [link](https://a.b)"), "quoted link");
}
