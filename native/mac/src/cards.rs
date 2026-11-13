use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{
    NSAccessibility, NSAttributedStringNSStringDrawing, NSButton, NSColor, NSFont, NSFontWeightMedium, NSFontWeightRegular, NSLineBreakMode,
    NSTextField, NSUserInterfaceItemIdentification, NSView,
};
use objc2_foundation::NSString;

use laterdog_core::cards::{self as words, ButtonLook};
use laterdog_core::store::{ApprovalPanel, CardLine, FoldIcon, QuestionFooter};

use crate::theme::{self, font, Theme, Weight};
use crate::widgets::{attributed, icon, label, rect, Fill, Flipped, ROUND};

pub const SEP: char = '\u{1f}';

pub struct Built {
    pub view: Retained<NSView>,
    pub height: f64,
}

pub type Delegate = objc2::runtime::ProtocolObject<dyn objc2_app_kit::NSTextFieldDelegate>;

struct Canvas<'a> {
    mtm: MainThreadMarker,
    view: Retained<NSView>,
    theme: &'a Theme,
    target: &'a AnyObject,
    delegate: Option<&'a Delegate>,
}

impl Canvas<'_> {
    fn add(&self, child: &NSView) {
        self.view.addSubview(child);
    }

    fn fill(&self, color: Option<&NSColor>, radius: f64, frame: (f64, f64, f64, f64)) -> Retained<Fill> {
        let fill = Fill::new(self.mtm, color, radius);
        fill.setFrame(rect(frame.0, frame.1, frame.2, frame.3));
        self.add(&fill);
        fill
    }

    fn line(&self, words: &str, font: &NSFont, color: &NSColor, x: f64, y: f64, width: f64) -> f64 {
        let field = label(self.mtm, words, font, color);
        let used = field.attributedStringValue().size().width.ceil() + 4.0;
        field.setFrame(rect(x - 2.0, y, used.min(width + 4.0), (font.pointSize() * 1.35).ceil()));
        self.add(&field);
        used.min(width + 4.0) - 4.0
    }

    fn wrapped(&self, words: &str, font: &NSFont, color: &NSColor, x: f64, y: f64, width: f64, line: Option<f64>) -> f64 {
        if words.is_empty() {
            return 0.0;
        }
        let string = attributed(words, font, color, line.map(|height| (height, 0.0)));
        let height = crate::rich::measure_at(&string, width).height.ceil();
        let field = NSTextField::wrappingLabelWithString(&NSString::from_str(words), self.mtm);
        field.setAttributedStringValue(&string);
        field.setSelectable(true);
        field.setDrawsBackground(false);
        field.setFrame(rect(x - 2.0, y, width + 4.0, height + 2.0));
        self.add(&field);
        height
    }

    fn button(&self, frame: (f64, f64, f64, f64), id: &str, action: Sel, spoken: &str, enabled: bool) -> Retained<NSButton> {
        let button = unsafe { NSButton::buttonWithTitle_target_action(&NSString::from_str(""), Some(self.target), Some(action), self.mtm) };
        button.setBordered(false);
        button.setTransparent(true);
        button.setIdentifier(Some(&NSString::from_str(id)));
        button.setFrame(rect(frame.0, frame.1, frame.2, frame.3));
        button.setEnabled(enabled);
        button.setAccessibilityLabel(Some(&NSString::from_str(spoken)));
        self.add(&button);
        button
    }

    fn symbol(&self, name: &str, size: f64, color: &NSColor, x: f64, y: f64, box_size: f64) {
        let image = icon(self.mtm, name, size, unsafe { NSFontWeightMedium }, color);
        image.setFrame(rect(x, y, box_size, box_size));
        self.add(&image);
    }

    #[allow(clippy::too_many_arguments)]
    fn pill(&self, words: &str, look: ButtonLook, x: f64, y: f64, min: f64, id: &str, action: Sel, enabled: bool, small: bool) -> f64 {
        let theme = self.theme;
        let (size, weight, pad, height) = match (look, small) {
            (ButtonLook::Durable, _) => (13.0, Weight::Medium, 10.0, 30.0),
            (_, true) => (13.0, Weight::Medium, 14.0, 26.0),
            _ => (13.5, Weight::Medium, 16.0, 36.0),
        };
        let text_font = font(size, weight);
        let (fill, ink) = match look {
            ButtonLook::Primary => (Some(&*theme.accent), &*theme.accent_ink),
            ButtonLook::Quiet => (Some(&*theme.control), &*theme.ink),
            ButtonLook::Durable => (None, &*theme.ink_secondary),
        };
        let text = attributed(words, &text_font, ink, None);
        let text_width = text.size().width.ceil();
        let width = (text_width + pad * 2.0).max(min);
        let shell = self.fill(fill, ROUND, (x, y, width, height));
        let field = label(self.mtm, words, &text_font, ink);
        field.setFrame(rect((width - text_width) / 2.0 - 2.0, (height - (size * 1.3).ceil()) / 2.0, text_width + 4.0, (size * 1.3).ceil()));
        shell.addSubview(&field);
        if !enabled {
            shell.setAlphaValue(0.4);
        }
        self.button((x, y, width, height), id, action, words, enabled);
        width
    }

    fn input(&self, frame: (f64, f64, f64, f64), placeholder: &str, value: &str, id: &str, action: Sel, round: bool, size: f64) -> Retained<NSTextField> {
        let theme = self.theme;
        let shell = self.fill(Some(if round { &*theme.composer } else { &*theme.inset }), if round { ROUND } else { 8.0 }, frame);
        shell.set_stroke(Some(if round { &*theme.ring_15 } else { &*theme.hairline_40 }), if round { 0.5 } else { 1.0 });
        let field = NSTextField::textFieldWithString(&NSString::from_str(value), self.mtm);
        field.setBezeled(false);
        field.setBordered(false);
        field.setDrawsBackground(false);
        field.setFocusRingType(objc2_app_kit::NSFocusRingType::None);
        field.setFont(Some(&font(size, Weight::Regular)));
        field.setTextColor(Some(&theme.ink));
        field.setPlaceholderString(Some(&NSString::from_str(placeholder)));
        field.setIdentifier(Some(&NSString::from_str(id)));
        unsafe {
            field.setTarget(Some(self.target));
            field.setAction(Some(action));
        }
        if let Some(cell) = field.cell() {
            cell.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
            cell.setScrollable(true);
        }
        let line = (size * 1.3).ceil();
        field.setFrame(rect(12.0, (frame.3 - line) / 2.0, frame.2 - 24.0, line));
        shell.addSubview(&field);
        field.setAccessibilityLabel(Some(&NSString::from_str(placeholder)));
        unsafe { field.setDelegate(self.delegate) };
        field
    }

    fn rows(&self, x: f64, y: f64, width: f64, rows: &[RowSpec]) -> f64 {
        let theme = self.theme;
        let row_height = 36.0;
        let total: f64 = rows.iter().map(|row| row.extra + row_height).sum();
        let shell = self.fill(None, 12.0, (x, y, width, total));
        shell.set_stroke(Some(&theme.hairline_40), 1.0);
        let mut top = y;
        for (index, row) in rows.iter().enumerate() {
            if index > 0 {
                self.fill(Some(&theme.hairline_40), 0.0, (x + 1.0, top, width - 2.0, 1.0));
            }
            if row.picked {
                let tint = self.fill(Some(&theme.raised_hover), if index == 0 || index + 1 == rows.len() { 11.0 } else { 0.0 }, (x + 1.0, top + if index > 0 { 1.0 } else { 1.0 }, width - 2.0, row_height - if index + 1 == rows.len() { 2.0 } else { 1.0 }));
                tint.setNeedsDisplay(true);
            }
            let marker_y = top + (row_height - 20.0) / 2.0;
            match row.marker {
                Marker::Round => {
                    self.fill(Some(&theme.control), ROUND, (x + 12.0, marker_y, 20.0, 20.0));
                    let letter = label(self.mtm, &row.letter, &font(11.0, Weight::Medium), &theme.ink_secondary);
                    letter.setAlignment(objc2_app_kit::NSTextAlignment::Center);
                    letter.setFrame(rect(x + 12.0, marker_y + 3.0, 20.0, 14.0));
                    self.add(&letter);
                }
                Marker::Square { checked, multi } => {
                    let marker = self.fill(if checked { Some(&*theme.accent) } else { None }, 6.0, (x + 12.0, marker_y, 20.0, 20.0));
                    marker.set_stroke(Some(if checked { &*theme.accent } else { &*theme.hairline }), 1.0);
                    if checked && multi {
                        self.symbol("checkmark", 10.0, &theme.accent_ink, x + 12.0, marker_y, 20.0);
                    } else {
                        let letter = label(self.mtm, &row.letter, &font(11.0, Weight::Medium), if checked { &theme.accent_ink } else { &theme.ink_secondary });
                        letter.setAlignment(objc2_app_kit::NSTextAlignment::Center);
                        letter.setFrame(rect(x + 12.0, marker_y + 3.0, 20.0, 14.0));
                        self.add(&letter);
                    }
                }
            }
            let gap = if matches!(row.marker, Marker::Round) { 10.0 } else { 12.0 };
            let text_x = x + 12.0 + 20.0 + gap;
            self.line(&row.text, &font(14.0, Weight::Regular), &theme.ink, text_x, top + (row_height - 19.0) / 2.0, width - (text_x - x) - 12.0);
            let button = self.button((x, top, width, row_height), &row.id, row.action, &row.text, row.enabled);
            if let Some(tip) = &row.tip {
                button.setToolTip(Some(&NSString::from_str(tip)));
            }
            top += row_height;
            if let Some(input) = &row.input {
                self.fill(Some(&theme.hairline_40), 0.0, (x + 1.0, top, width - 2.0, 1.0));
                let field = self.input((x + 12.0, top + 10.0, width - 24.0, 38.0), words::QUESTION_OTHER_PLACEHOLDER, &input.value, &input.id, sel!(questionEnter:), false, 14.5);
                if input.focus {
                    field.setRefusesFirstResponder(false);
                }
                top += row.extra;
            }
        }
        total
    }
}

enum Marker {
    Round,
    Square { checked: bool, multi: bool },
}

struct InputSpec {
    value: String,
    id: String,
    focus: bool,
}

struct RowSpec {
    letter: String,
    text: String,
    picked: bool,
    marker: Marker,
    id: String,
    action: Sel,
    enabled: bool,
    tip: Option<String>,
    input: Option<InputSpec>,
    extra: f64,
}

fn shell(canvas: &Canvas<'_>, width: f64, height: f64, open: bool, radius: f64) {
    let card = canvas.fill(Some(&canvas.theme.card), radius, (0.0, 0.0, width, height));
    if open {
        card.set_stroke(Some(&canvas.theme.ring_10), 0.5);
    } else {
        canvas.view.setAlphaValue(0.7);
    }
}

pub fn card(mtm: MainThreadMarker, line: &CardLine, width: f64, theme: &Theme, target: &AnyObject, delegate: Option<&Delegate>) -> Built {
    let view: Retained<NSView> = Retained::into_super(Flipped::new(mtm));
    let canvas = Canvas { mtm, view, theme, target, delegate };
    let card_width = theme::CARD_MAX.min(width);
    let inner = card_width - 32.0;
    let height = match line {
        CardLine::Waiting { line, note } => {
            canvas.symbol("hand.raised", 12.0, &theme.ink_secondary, 0.0, 2.0, 18.0);
            let used = canvas.line(line, &font(13.0, Weight::Regular), &theme.ink_secondary, 20.0, 2.0, (card_width - 20.0) * 0.7);
            canvas.line(&format!(" \u{b7} {note}"), &font(13.0, Weight::Regular), &theme.ink_tertiary, 20.0 + used, 2.0, card_width - 20.0 - used);
            canvas.view.setAccessibilityLabel(Some(&NSString::from_str(&format!("{line} \u{b7} {note}"))));
            22.0
        }
        CardLine::Folded { icon: mark, summary, trailing, label: spoken, centered } => {
            let text_font = font(13.0, Weight::Regular);
            let summary_width = attributed(summary, &text_font, &theme.ink_secondary, None).size().width.ceil();
            let trailing_words = trailing.as_ref().map(|words| format!(" \u{b7} {words}")).unwrap_or_default();
            let trailing_width = attributed(&trailing_words, &text_font, &theme.ink_tertiary, None).size().width.ceil();
            let total = (14.0 + 6.0 + summary_width + trailing_width + 6.0 + 13.0).min(width);
            let left = if *centered { ((width - total) / 2.0).round() } else { 0.0 };
            let (symbol, color) = match mark {
                FoldIcon::Check => ("checkmark", &theme.success),
                FoldIcon::Minus => ("minus", &theme.ink_secondary),
                FoldIcon::Cross => ("xmark", &theme.ink_secondary),
                FoldIcon::Sending => ("arrow.trianglehead.2.clockwise", &theme.ink_secondary),
            };
            canvas.symbol(symbol, 11.0, color, left, 3.0, 14.0);
            let used = canvas.line(summary, &text_font, &theme.ink_secondary, left + 20.0, 2.0, total - 20.0 - 19.0);
            let mut x = left + 20.0 + used;
            if !trailing_words.is_empty() {
                x += canvas.line(&trailing_words, &text_font, &theme.ink_tertiary, x, 2.0, (total - (x - left) - 19.0).max(0.0));
            }
            canvas.symbol("chevron.right", 9.0, &theme.ink_tertiary, x + 6.0, 3.0, 14.0);
            canvas.view.setAccessibilityLabel(Some(&NSString::from_str(spoken)));
            canvas.view.setToolTip(Some(&NSString::from_str(&format!("{summary}{trailing_words}"))));
            22.0
        }
        CardLine::Options { message_id, title, subtitle, choices, custom, dismiss, error } => {
            let mut y = 14.0;
            let title_font = font(14.0, Weight::Medium);
            let title_height = canvas.wrapped(title, &title_font, &theme.ink, 16.0, y, inner - if *dismiss { 32.0 } else { 0.0 }, None);
            y += title_height;
            if !subtitle.is_empty() {
                y += 2.0 + canvas.wrapped(subtitle, &font(13.0, Weight::Regular), &theme.ink_secondary, 16.0, y + 2.0, inner - if *dismiss { 32.0 } else { 0.0 }, None);
            }
            if *dismiss {
                canvas.symbol("xmark", 11.0, &theme.ink_secondary, card_width - 16.0 - 24.0 + 4.0, 12.0, 16.0);
                let button = canvas.button((card_width - 16.0 - 24.0, 8.0, 24.0, 24.0), message_id, sel!(cardDismiss:), words::DISMISS, true);
                button.setToolTip(Some(&NSString::from_str(words::DISMISS)));
            }
            y += 10.0;
            let rows: Vec<RowSpec> = choices
                .iter()
                .enumerate()
                .map(|(index, choice)| RowSpec {
                    letter: words::LETTERS[index].to_owned(),
                    text: choice.clone(),
                    picked: false,
                    marker: Marker::Round,
                    id: format!("{message_id}{SEP}{index}"),
                    action: sel!(cardChoice:),
                    enabled: true,
                    tip: None,
                    input: None,
                    extra: 0.0,
                })
                .collect();
            if !rows.is_empty() {
                y += canvas.rows(16.0, y, inner, &rows);
            }
            if *custom {
                y += 8.0;
                canvas.input((16.0, y, inner, 32.0), words::CUSTOM_PLACEHOLDER, "", message_id, sel!(cardCustom:), true, 13.0);
                y += 32.0;
            }
            y += 14.0;
            let height = y;
            if let Some(error) = error {
                let extra = canvas.wrapped(error, &font(12.5, Weight::Regular), &theme.warning, 4.0, height + 6.0, card_width - 8.0, None);
                shell_under(&canvas, card_width, height, true, theme::QUESTION_RADIUS);
                height + 6.0 + extra
            } else {
                shell_under(&canvas, card_width, height, true, theme::QUESTION_RADIUS);
                height
            }
        }
        CardLine::Question { message_id, title, actor, origin, step, tabs, question, multi, options, other_letter, other, custom, footer, error } => {
            let mut y = 14.0;
            let title_height = canvas.wrapped(title, &font(14.0, Weight::Medium), &theme.ink, 16.0, y, inner - 80.0, None);
            let mut right = card_width - 16.0;
            canvas.symbol("xmark", 11.0, &theme.ink_secondary, right - 24.0 + 4.0, y - 2.0, 16.0);
            let close = canvas.button((right - 24.0, y - 6.0, 24.0, 24.0), message_id, sel!(cardDismiss:), words::QUESTION_CLOSE, true);
            close.setToolTip(Some(&NSString::from_str(words::QUESTION_CLOSE)));
            right -= 24.0 + 8.0;
            if let Some(step) = step {
                let step_font = font(12.0, Weight::Regular);
                let step_width = attributed(step, &step_font, &theme.ink_secondary, None).size().width.ceil();
                canvas.line(step, &step_font, &theme.ink_secondary, right - step_width, y + 1.0, step_width);
            }
            y += title_height;
            if let Some(actor) = actor {
                y += 4.0 + canvas.wrapped(actor, &font(11.0, Weight::Regular), &theme.ink_secondary, 16.0, y + 4.0, inner, None);
            }
            if *origin {
                y += 4.0 + canvas.wrapped(words::QUESTION_ORIGIN, &font(12.0, Weight::Regular), &theme.ink_secondary, 16.0, y + 4.0, inner, None);
            }
            if !tabs.is_empty() {
                y += 10.0;
                for (index, tab) in tabs.iter().enumerate() {
                    let x = 16.0 + index as f64 * 30.0;
                    let color = if tab.current { &theme.ink } else if tab.answered { &theme.success } else { &theme.hairline };
                    canvas.fill(Some(color), ROUND, (x, y + 8.0, 24.0, 4.0));
                    let button = canvas.button((x, y, 24.0, 20.0), &format!("{message_id}{SEP}go{SEP}{index}"), sel!(questionStep:), &tab.label, true);
                    button.setToolTip(Some(&NSString::from_str(&tab.label)));
                }
                y += 20.0 - 6.0;
            }
            y += 6.0 + canvas.wrapped(question, &font(14.0, Weight::Regular), &theme.ink, 16.0, y + 6.0, inner, Some(21.0));
            if *multi {
                y += 4.0 + canvas.wrapped(words::QUESTION_MULTI_HINT, &font(12.5, Weight::Regular), &theme.ink_secondary, 16.0, y + 4.0, inner, None);
            }
            y += 10.0;
            let mut rows: Vec<RowSpec> = options
                .iter()
                .enumerate()
                .map(|(index, option)| RowSpec {
                    letter: option.letter.clone(),
                    text: option.label.clone(),
                    picked: option.picked,
                    marker: Marker::Square { checked: option.picked, multi: *multi },
                    id: format!("{message_id}{SEP}choose{SEP}{index}"),
                    action: sel!(questionStep:),
                    enabled: true,
                    tip: option.description.clone(),
                    input: None,
                    extra: 0.0,
                })
                .collect();
            rows.push(RowSpec {
                letter: other_letter.clone(),
                text: words::QUESTION_OTHER.to_owned(),
                picked: *other,
                marker: Marker::Square { checked: *other, multi: *multi },
                id: format!("{message_id}{SEP}other"),
                action: sel!(questionStep:),
                enabled: true,
                tip: None,
                input: other.then(|| InputSpec { value: custom.clone(), id: message_id.clone(), focus: true }),
                extra: if *other { 58.0 } else { 0.0 },
            });
            y += canvas.rows(16.0, y, inner, &rows);
            match footer {
                QuestionFooter::None => {}
                QuestionFooter::Steps { back, next, next_enabled, .. } => {
                    y += 12.0;
                    if *back {
                        canvas.symbol("chevron.left", 10.0, &theme.ink_secondary, 16.0, y + 6.0, 14.0);
                        canvas.line(words::QUESTION_BACK, &font(13.0, Weight::Regular), &theme.ink_secondary, 32.0, y + 4.0, 80.0);
                        canvas.button((12.0, y, 80.0, 26.0), &format!("{message_id}{SEP}back"), sel!(questionStep:), words::QUESTION_BACK, true);
                    }
                    let id = format!("{message_id}{SEP}{}", if *next == words::QUESTION_NEXT { "next" } else { "submit" });
                    let label_width = attributed(next, &font(13.0, Weight::Medium), &theme.accent_ink, None).size().width.ceil() + 28.0;
                    canvas.pill(next, ButtonLook::Primary, card_width - 16.0 - label_width, y, 0.0, &id, sel!(questionStep:), *next_enabled, true);
                    y += 26.0;
                }
                QuestionFooter::Submit { enabled } => {
                    y += 12.0;
                    let label_width = attributed(words::QUESTION_SUBMIT, &font(13.0, Weight::Medium), &theme.accent_ink, None).size().width.ceil() + 24.0;
                    let pill_x = card_width - 16.0 - label_width;
                    canvas.pill(words::QUESTION_SUBMIT, ButtonLook::Primary, pill_x, y, 0.0, &format!("{message_id}{SEP}submit"), sel!(questionStep:), *enabled, true);
                    let waiting_font = font(13.0, Weight::Regular);
                    let waiting_width = attributed(words::QUESTION_WAITING, &waiting_font, &theme.ink_secondary, None).size().width.ceil();
                    canvas.line(words::QUESTION_WAITING, &waiting_font, &theme.ink_secondary, pill_x - 12.0 - waiting_width, y + 4.0, waiting_width);
                    canvas.symbol("questionmark.bubble", 11.0, &theme.accent, pill_x - 12.0 - waiting_width - 20.0, y + 5.0, 14.0);
                    y += 26.0;
                }
            }
            y += 14.0;
            let height = y;
            shell_under(&canvas, card_width, height, true, theme::QUESTION_RADIUS);
            canvas.view.setAccessibilityLabel(Some(&NSString::from_str("Question from your dog")));
            match error {
                Some(error) => height + 6.0 + canvas.wrapped(error, &font(12.5, Weight::Regular), &theme.warning, 4.0, height + 6.0, card_width - 8.0, None),
                None => height,
            }
        }
    };
    let view = canvas.view;
    view.setFrame(rect(0.0, 0.0, width, height));
    Built { view, height }
}

fn shell_under(canvas: &Canvas<'_>, width: f64, height: f64, open: bool, radius: f64) {
    let before: Vec<Retained<NSView>> = canvas.view.subviews().iter().collect();
    for child in &before {
        child.removeFromSuperview();
    }
    shell(canvas, width, height, open, radius);
    for child in &before {
        canvas.add(child);
    }
}

pub fn approval(mtm: MainThreadMarker, panel: &ApprovalPanel, width: f64, theme: &Theme, target: &AnyObject, open: (bool, bool)) -> Built {
    let view: Retained<NSView> = Retained::into_super(Flipped::new(mtm));
    let canvas = Canvas { mtm, view, theme, target, delegate: None };
    let (details_open, reach_open) = open;
    let inner = width - 32.0;
    let mut y = 12.0;
    canvas.symbol("hand.raised", 13.0, &theme.ink_secondary, 16.0, y + 1.0, 18.0);
    let mut x = 16.0 + 18.0 + 8.0;
    if let Some(position) = &panel.position {
        let chip_font = font(11.0, Weight::Regular);
        let chip = attributed(position, &chip_font, &theme.ink_secondary, None).size().width.ceil() + 12.0;
        canvas.fill(Some(&theme.control), ROUND, (x, y + 1.0, chip, 18.0));
        canvas.line(position, &chip_font, &theme.ink_secondary, x + 6.0, y + 3.0, chip);
        x += chip + 8.0;
    }
    let label_height = canvas.wrapped(&panel.label, &font(14.0, Weight::Medium), &theme.ink, x, y, width - 16.0 - x, None).max(20.0);
    y += label_height;
    let mono = NSFont::monospacedSystemFontOfSize_weight(12.0, unsafe { NSFontWeightRegular });
    let detail_box = |canvas: &Canvas<'_>, y: f64| -> f64 {
        let string = attributed(&panel.detail, &mono, &theme.ink, Some((19.5, 0.0)));
        let text = crate::rich::measure_at(&string, inner - 24.0).height.ceil().min(160.0 - 16.0);
        let shell = canvas.fill(Some(&theme.inset), 8.0, (16.0, y, inner, text + 16.0));
        let field = NSTextField::wrappingLabelWithString(&NSString::from_str(&panel.detail), canvas.mtm);
        field.setAttributedStringValue(&string);
        field.setSelectable(true);
        field.setFrame(rect(10.0, 8.0, inner - 20.0, text));
        shell.addSubview(&field);
        text + 16.0
    };
    if panel.reviewed {
        y += 6.0;
        let used = canvas.line(words::APPROVAL_VIEW_DETAILS, &font(13.0, Weight::Regular), &theme.ink_secondary, 16.0, y, inner);
        canvas.symbol(if details_open { "chevron.down" } else { "chevron.right" }, 9.0, &theme.ink_secondary, 16.0 + used + 4.0, y + 1.0, 14.0);
        canvas.button((12.0, y - 2.0, used + 26.0, 20.0), &format!("{}{SEP}details", panel.message_id), sel!(approvalToggle:), words::APPROVAL_VIEW_DETAILS, true);
        y += 18.0;
        if details_open && !panel.detail.is_empty() {
            y += 8.0 + detail_box(&canvas, y + 8.0);
        }
    } else if !panel.detail.is_empty() {
        y += 8.0 + detail_box(&canvas, y + 8.0);
    }
    if let Some(held) = &panel.held {
        y += 6.0 + canvas.wrapped(held, &font(12.0, Weight::Regular), &theme.ink_secondary, 16.0, y + 6.0, inner, None);
    }
    y += 4.0 + 4.0;
    let mut bx = 12.0;
    let mut row_top = y;
    for (index, decision) in panel.decisions.iter().enumerate() {
        let min = if decision.look == ButtonLook::Durable { 0.0 } else { 120.0 };
        let estimate = attributed(&decision.label, &font(13.5, Weight::Medium), &theme.ink, None).size().width.ceil() + 32.0;
        if bx + estimate.max(min) > width - 12.0 && bx > 12.0 {
            bx = 12.0;
            row_top += 36.0 + 8.0;
        }
        let top = if decision.look == ButtonLook::Durable { row_top + 3.0 } else { row_top };
        let used = canvas.pill(&decision.label, decision.look, bx, top, min, &format!("{}{SEP}{index}", panel.message_id), sel!(decide:), decision.enabled && !panel.sending, false);
        bx += used + 8.0;
    }
    y = row_top + 36.0;
    if panel.sending {
        y += 4.0 + canvas.wrapped(words::SENDING, &font(12.0, Weight::Regular), &theme.ink_tertiary, 16.0, y + 4.0, inner, None);
    } else if let Some(reach) = &panel.reach {
        y += 4.0;
        let used = canvas.line(words::APPROVAL_REACH_WHAT, &font(12.0, Weight::Regular), &theme.ink_tertiary, 16.0, y, inner);
        canvas.symbol(if reach_open { "chevron.down" } else { "chevron.right" }, 8.0, &theme.ink_tertiary, 16.0 + used + 3.0, y + 1.0, 13.0);
        canvas.button((12.0, y - 2.0, used + 24.0, 18.0), &format!("{}{SEP}reach", panel.message_id), sel!(approvalToggle:), words::APPROVAL_REACH_WHAT, true);
        y += 16.0;
        if reach_open {
            y += 4.0 + canvas.wrapped(reach, &font(12.0, Weight::Regular), &theme.ink_tertiary, 16.0, y + 4.0, inner, None);
        }
    }
    if let Some(error) = &panel.error {
        y += 6.0 + canvas.wrapped(error, &font(12.5, Weight::Regular), &theme.warning, 16.0, y + 6.0, inner, None);
    }
    y += 12.0;
    let before: Vec<Retained<NSView>> = canvas.view.subviews().iter().collect();
    for child in &before {
        child.removeFromSuperview();
    }
    let card = canvas.fill(Some(&theme.card), theme::CARD_RADIUS, (0.0, 0.0, width, y));
    card.set_stroke(Some(&theme.ring_15), 0.5);
    for child in &before {
        canvas.add(child);
    }
    canvas.view.setAccessibilityLabel(Some(&NSString::from_str(words::APPROVAL_PENDING)));
    let view = canvas.view;
    view.setFrame(rect(0.0, 0.0, width, y));
    Built { view, height: y }
}

pub fn split(id: &str) -> (String, Vec<String>) {
    let mut parts = id.split(SEP).map(str::to_owned);
    let first = parts.next().unwrap_or_default();
    (first, parts.collect())
}
