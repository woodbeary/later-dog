use std::cell::{Cell, OnceCell, RefCell};

use laterdog_core::markdown::{self, Block, Inline};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message};
use objc2_app_kit::{
    NSAttributedStringNSStringDrawing, NSBaselineOffsetAttributeName, NSBezierPath, NSButton, NSColor, NSCursor,
    NSCursorAttributeName, NSEvent, NSFont, NSFontAttributeName, NSFontDescriptorSymbolicTraits, NSFontWeightBold,
    NSFontWeightRegular, NSFontWeightSemibold, NSForegroundColorAttributeName, NSImageView,
    NSKernAttributeName, NSLayoutManager, NSLineBreakMode, NSLinkAttributeName, NSMutableParagraphStyle,
    NSParagraphStyleAttributeName, NSPasteboard, NSPasteboardTypeString, NSSavePanel, NSScrollView,
    NSScrollerStyle, NSTextAlignment, NSTextContainer, NSTextField, NSTextStorage, NSTextTab, NSTextTabType, NSTextView,
    NSTextViewDelegate, NSUnderlineColorAttributeName, NSUnderlineStyleAttributeName, NSView,
};
use objc2_foundation::{
    NSArray, NSAttributedString, NSDictionary, NSMutableAttributedString, NSNumber, NSPoint, NSRange,
    NSRect, NSSize, NSString, NSURL,
};

use crate::theme::{self, Theme};
use crate::widgets::{icon, label, rect, Fill};

pub const LINE: f64 = theme::BUBBLE_LINE;
const BLOCK_GAP: f64 = 8.0;
const ITEM_GAP: f64 = 4.0;
const LIST_INDENT: f64 = 20.0;
const QUOTE_INDENT: f64 = 14.0;
const QUOTE_BAR: f64 = 2.0;
const CODE_PAD: f64 = 4.0;
const CODE_SIZE: f64 = 13.0;
const CODE_LINE: f64 = 21.125;
const CODE_INSET: f64 = 12.0;
const CODE_HEADER: f64 = 35.0;
const CODE_RADIUS: f64 = 10.0;
const HUGE: f64 = 10_000_000.0;
const CODE_KEY: &str = "LaterdogCode";
const QUOTE_KEY: &str = "LaterdogQuote";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Weight {
    Regular,
    Semibold,
    Bold,
}

fn system(size: f64, weight: Weight, italic: bool, mono: bool) -> Retained<NSFont> {
    let weight = unsafe {
        match weight {
            Weight::Regular => NSFontWeightRegular,
            Weight::Semibold => NSFontWeightSemibold,
            Weight::Bold => NSFontWeightBold,
        }
    };
    let base = if mono { NSFont::monospacedSystemFontOfSize_weight(size, weight) } else { NSFont::systemFontOfSize_weight(size, weight) };
    if !italic {
        return base;
    }
    let descriptor = base.fontDescriptor();
    let traits = descriptor.symbolicTraits() | NSFontDescriptorSymbolicTraits::TraitItalic;
    NSFont::fontWithDescriptor_size(&descriptor.fontDescriptorWithSymbolicTraits(traits), size).unwrap_or(base)
}

fn lift(font: &NSFont, line: f64) -> f64 {
    ((line - (font.ascender() - font.descender())) / 2.0).round()
}

pub struct Inks {
    pub text: Retained<NSColor>,
    pub secondary: Retained<NSColor>,
    pub link: Retained<NSColor>,
    pub link_line: Retained<NSColor>,
}

impl Inks {
    pub fn reply(theme: &Theme) -> Self {
        Inks { text: theme.ink.clone(), secondary: theme.ink_secondary.clone(), link: theme.accent.clone(), link_line: theme.link_line.clone() }
    }

    pub fn mine(theme: &Theme) -> Self {
        Inks { text: theme.white.clone(), secondary: theme.white.clone(), link: theme.white.clone(), link_line: theme.white.clone() }
    }
}

#[derive(Clone)]
struct Frame {
    indent: f64,
    quotes: Vec<f64>,
    secondary: bool,
    gap: f64,
}

#[derive(Clone)]
struct Style {
    size: f64,
    weight: Weight,
    italic: bool,
    color: Retained<NSColor>,
    link: Option<Option<String>>,
    paragraph: Retained<NSMutableParagraphStyle>,
    lift: f64,
    quote: Option<String>,
}

pub enum Piece {
    Text { string: Retained<NSAttributedString>, lead: f64 },
    Code { language: String, code: String, index: usize, wrap: bool },
    Table { text: String },
    Rule,
}

pub struct Placed {
    pub piece: Piece,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub inner: f64,
}

pub struct Layout {
    pub pieces: Vec<Placed>,
    pub width: f64,
    pub height: f64,
}

struct Builder<'a> {
    inks: &'a Inks,
    pieces: Vec<(Piece, f64)>,
    current: Option<Retained<NSMutableAttributedString>>,
    last: Option<Style>,
    lead: f64,
    codes: usize,
    wraps: &'a [usize],
}

fn key(name: &str) -> Retained<NSString> {
    NSString::from_str(name)
}

fn run(words: &str, style: &Style, extra: &[(&NSString, &AnyObject)]) -> Retained<NSAttributedString> {
    let font = system(style.size, style.weight, style.italic, false);
    let lift = NSNumber::new_f64(style.lift);
    let mut keys: Vec<&NSString> = unsafe { vec![NSFontAttributeName, NSForegroundColorAttributeName, NSParagraphStyleAttributeName, NSBaselineOffsetAttributeName] };
    let mut objects: Vec<&AnyObject> = vec![font.as_ref(), style.color.as_ref(), style.paragraph.as_ref(), lift.as_ref()];
    let quote_key = key(QUOTE_KEY);
    let quote_value = style.quote.as_deref().map(NSString::from_str);
    if let Some(value) = &quote_value {
        keys.push(&quote_key);
        objects.push(value.as_ref());
    }
    for (name, value) in extra {
        keys.push(name);
        objects.push(value);
    }
    let attributes = NSDictionary::from_slices(&keys, &objects);
    unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(words), &attributes) }
}

impl<'a> Builder<'a> {
    fn out(&mut self) -> Retained<NSMutableAttributedString> {
        self.current.get_or_insert_with(NSMutableAttributedString::new).clone()
    }

    fn flush(&mut self) {
        if let Some(string) = self.current.take() {
            let lead = std::mem::replace(&mut self.lead, 0.0);
            self.pieces.push((Piece::Text { string: Retained::into_super(string), lead }, 0.0));
        }
        self.last = None;
    }

    fn view(&mut self, piece: Piece, indent: f64) {
        self.flush();
        self.pieces.push((piece, indent));
    }

    fn paragraph_style(&self, frame: &Frame, spacing: f64, marker: bool) -> Retained<NSMutableParagraphStyle> {
        let style = NSMutableParagraphStyle::new();
        style.setMinimumLineHeight(LINE);
        style.setMaximumLineHeight(LINE);
        style.setLineBreakMode(NSLineBreakMode::ByWordWrapping);
        style.setAlignment(NSTextAlignment::Left);
        style.setHeadIndent(frame.indent);
        style.setFirstLineHeadIndent(if marker { frame.indent - LIST_INDENT } else { frame.indent });
        style.setParagraphSpacingBefore(spacing);
        let stops: Vec<Retained<NSTextTab>> = if marker {
            vec![
                NSTextTab::initWithType_location(NSTextTab::alloc(), NSTextTabType::RightTabStopType, frame.indent - 5.0),
                NSTextTab::initWithType_location(NSTextTab::alloc(), NSTextTabType::LeftTabStopType, frame.indent),
            ]
        } else {
            Vec::new()
        };
        style.setTabStops(Some(&NSArray::from_retained_slice(&stops)));
        style.setDefaultTabInterval(LIST_INDENT);
        style
    }

    fn paragraph(&mut self, content: &[Inline], size: f64, semibold: bool, secondary: bool, spacing: f64, frame: &Frame, marker: Option<String>, lead: f64) {
        let out = self.out();
        let started = out.length() > 0;
        if let Some(previous) = self.last.clone().filter(|_| started) {
            out.appendAttributedString(&run("\n", &previous, &[]));
        }
        if !started {
            self.lead = lead;
        }
        let paragraph = self.paragraph_style(frame, if started { spacing } else { 0.0 }, marker.is_some());
        let weight = if semibold { Weight::Semibold } else { Weight::Regular };
        let base = system(size, weight, false, false);
        let color = if secondary || frame.secondary { self.inks.secondary.clone() } else { self.inks.text.clone() };
        let quote = (!frame.quotes.is_empty()).then(|| frame.quotes.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(","));
        let style = Style { size, weight, italic: false, color, link: None, paragraph: paragraph.clone(), lift: lift(&base, LINE), quote };
        if let Some(marker) = marker {
            out.appendAttributedString(&run(&format!("\t{marker}\t"), &style, &[]));
        }
        self.inlines(&out, content, &style);
        self.last = Some(style);
    }

    fn inlines(&self, out: &NSMutableAttributedString, content: &[Inline], style: &Style) {
        for inline in content {
            match inline {
                Inline::Text { text } => out.appendAttributedString(&self.styled(text, style)),
                Inline::Break => out.appendAttributedString(&run("\u{2028}", style, &[])),
                Inline::Strong { children } => {
                    let mut inner = style.clone();
                    inner.weight = Weight::Bold;
                    self.inlines(out, children, &inner);
                }
                Inline::Emphasis { children } => {
                    let mut inner = style.clone();
                    inner.italic = true;
                    self.inlines(out, children, &inner);
                }
                Inline::Link { href, children } => {
                    let mut inner = style.clone();
                    inner.link = Some(href.clone());
                    self.inlines(out, children, &inner);
                }
                Inline::Code { text } => self.code_span(out, text, style),
            }
        }
    }

    fn styled(&self, words: &str, style: &Style) -> Retained<NSAttributedString> {
        let Some(href) = &style.link else { return run(words, style, &[]) };
        let mut linked = style.clone();
        linked.color = self.inks.link.clone();
        let underline = NSNumber::new_isize(1);
        let url = href.as_deref().and_then(|href| NSURL::URLWithString(&NSString::from_str(href)));
        let hand = NSCursor::pointingHandCursor();
        let mut extra: Vec<(&NSString, &AnyObject)> = unsafe { vec![(NSUnderlineStyleAttributeName, underline.as_ref()), (NSUnderlineColorAttributeName, self.inks.link_line.as_ref())] };
        if let Some(url) = &url {
            unsafe {
                extra.push((NSLinkAttributeName, url.as_ref()));
                extra.push((NSCursorAttributeName, hand.as_ref()));
            }
        }
        run(words, &linked, &extra)
    }

    fn code_span(&self, out: &NSMutableAttributedString, words: &str, style: &Style) {
        if words.is_empty() {
            return;
        }
        let pad = NSNumber::new_f64(CODE_PAD);
        out.appendAttributedString(&run("\u{200b}", style, unsafe { &[(NSKernAttributeName, pad.as_ref())] }));
        let weight = unsafe { if style.weight == Weight::Regular { NSFontWeightRegular } else { NSFontWeightBold } };
        let font = NSFont::monospacedSystemFontOfSize_weight(CODE_SIZE, weight);
        let height = NSNumber::new_f64(font.ascender() - font.descender() + 2.0);
        let code_key = key(CODE_KEY);
        let mut coded = style.clone();
        coded.size = CODE_SIZE;
        let start = out.length();
        let piece = if style.link.is_some() { self.styled(words, &coded) } else { run(words, &coded, &[]) };
        let mutable = NSMutableAttributedString::new();
        mutable.appendAttributedString(&piece);
        let whole = NSRange::new(0, mutable.length());
        unsafe {
            mutable.addAttribute_value_range(NSFontAttributeName, font.as_ref(), whole);
            mutable.addAttribute_value_range(&code_key, height.as_ref(), whole);
        }
        out.appendAttributedString(&mutable);
        let last = words.chars().last().map_or(1, |c| c.len_utf16());
        let end = start + mutable.length();
        unsafe { out.addAttribute_value_range(NSKernAttributeName, pad.as_ref(), NSRange::new(end - last, last)) };
    }

    fn blocks(&mut self, blocks: &[Block], frame: &Frame, first_spacing: f64, top: bool) {
        for (index, block) in blocks.iter().enumerate() {
            let spacing = if index == 0 { first_spacing } else { frame.gap };
            match block {
                Block::Paragraph { content } => self.paragraph(content, 14.0, false, false, spacing, frame, None, 0.0),
                Block::Heading { level, content } => {
                    let (size, secondary, margin) = match level {
                        1 => (16.0, false, 8.0),
                        2 => (15.5, false, 8.0),
                        3 | 4 => (14.0, false, 6.0),
                        5 => (14.0, false, 6.0),
                        _ => (13.5, true, 6.0),
                    };
                    let spacing = if index == 0 && !top { spacing.max(margin) } else { spacing };
                    self.paragraph(content, size, true, secondary, spacing, frame, None, if top && index == 0 { margin } else { 0.0 });
                }
                Block::List { ordered, start, items } => {
                    let depth = frame.indent_depth();
                    for (number, item) in items.iter().enumerate() {
                        let marker = if *ordered { format!("{}.", start + number as u64) } else { ["\u{2022}", "\u{25e6}", "\u{25aa}"][depth.min(2)].to_owned() };
                        let mut inner = frame.clone();
                        inner.indent += LIST_INDENT;
                        inner.gap = 0.0;
                        let item_spacing = if number == 0 { spacing } else { ITEM_GAP };
                        match item.first() {
                            Some(Block::Paragraph { content }) => {
                                self.paragraph(content, 14.0, false, false, item_spacing, &inner, Some(marker), 0.0);
                                self.blocks(&item[1..], &inner, 0.0, false);
                            }
                            _ => {
                                self.paragraph(&[], 14.0, false, false, item_spacing, &inner, Some(marker), 0.0);
                                self.blocks(item, &inner, 0.0, false);
                            }
                        }
                    }
                }
                Block::Quote { blocks } => {
                    let mut inner = frame.clone();
                    inner.quotes.push(frame.indent);
                    inner.indent += QUOTE_INDENT;
                    inner.secondary = true;
                    inner.gap = 0.0;
                    self.blocks(blocks, &inner, spacing, false);
                }
                Block::Code { language, text } => {
                    let index = self.codes;
                    self.codes += 1;
                    let wrap = self.wraps.contains(&index);
                    self.view(Piece::Code { language: language.clone(), code: text.clone(), index, wrap }, frame.indent);
                }
                Block::Table { rows } => self.view(Piece::Table { text: markdown::table_text(rows) }, frame.indent),
                Block::Rule => self.view(Piece::Rule, frame.indent),
            }
        }
    }
}

impl Frame {
    fn indent_depth(&self) -> usize {
        let quoted = self.quotes.len() as f64 * QUOTE_INDENT;
        ((self.indent - quoted) / LIST_INDENT).max(0.0).round() as usize
    }
}

pub fn lines_text(lines: &[(String, Retained<NSColor>, bool, f64)]) -> Retained<NSAttributedString> {
    let out = NSMutableAttributedString::new();
    for (index, (words, color, medium, spacing)) in lines.iter().enumerate() {
        let paragraph = NSMutableParagraphStyle::new();
        paragraph.setMinimumLineHeight(18.0);
        paragraph.setMaximumLineHeight(18.0);
        paragraph.setLineBreakMode(NSLineBreakMode::ByWordWrapping);
        paragraph.setParagraphSpacingBefore(if index == 0 { 0.0 } else { *spacing });
        let font = if *medium { crate::theme::font(12.0, crate::theme::Weight::Medium) } else { system(12.0, Weight::Regular, false, false) };
        let style = Style { size: 12.0, weight: Weight::Regular, italic: false, color: color.clone(), link: None, paragraph, lift: lift(&font, 18.0), quote: None };
        let shown = if index + 1 < lines.len() { format!("{words}\n") } else { words.clone() };
        let piece = run(&shown, &style, &[]);
        let mutable = NSMutableAttributedString::new();
        mutable.appendAttributedString(&piece);
        unsafe { mutable.addAttribute_value_range(NSFontAttributeName, font.as_ref(), NSRange::new(0, mutable.length())) };
        out.appendAttributedString(&mutable);
    }
    Retained::into_super(out)
}

pub fn measure_at(string: &NSAttributedString, width: f64) -> NSSize {
    measure(string, width)
}

pub fn plain_text(words: &str, inks: &Inks) -> Retained<NSAttributedString> {
    let paragraph = NSMutableParagraphStyle::new();
    paragraph.setMinimumLineHeight(LINE);
    paragraph.setMaximumLineHeight(LINE);
    paragraph.setLineBreakMode(NSLineBreakMode::ByWordWrapping);
    let base = system(14.0, Weight::Regular, false, false);
    let style = Style { size: 14.0, weight: Weight::Regular, italic: false, color: inks.text.clone(), link: None, paragraph, lift: lift(&base, LINE), quote: None };
    run(words, &style, &[])
}

thread_local! {
    static MEASURE: (Retained<NSTextStorage>, Retained<NSLayoutManager>, Retained<NSTextContainer>) = {
        let storage = NSTextStorage::new();
        let layout = NSLayoutManager::new();
        let container = NSTextContainer::initWithSize(NSTextContainer::alloc(), NSSize::new(HUGE, HUGE));
        container.setLineFragmentPadding(0.0);
        layout.addTextContainer(&container);
        storage.addLayoutManager(&layout);
        (storage, layout, container)
    };
}

fn measure(string: &NSAttributedString, width: f64) -> NSSize {
    MEASURE.with(|(storage, layout, container)| {
        storage.setAttributedString(string);
        container.setSize(NSSize::new(width, HUGE));
        layout.ensureLayoutForTextContainer(container);
        let used = layout.usedRectForTextContainer(container);
        NSSize::new(used.size.width.ceil(), used.size.height.ceil())
    })
}

fn code_string(code: &str, theme: &Theme) -> Retained<NSAttributedString> {
    let paragraph = NSMutableParagraphStyle::new();
    paragraph.setMinimumLineHeight(CODE_LINE);
    paragraph.setMaximumLineHeight(CODE_LINE);
    paragraph.setLineBreakMode(NSLineBreakMode::ByCharWrapping);
    let font = NSFont::monospacedSystemFontOfSize_weight(CODE_SIZE, unsafe { NSFontWeightRegular });
    let lift = NSNumber::new_f64(((CODE_LINE - (font.ascender() - font.descender())) / 2.0).round());
    let keys: [&NSString; 4] = unsafe { [NSFontAttributeName, NSForegroundColorAttributeName, NSParagraphStyleAttributeName, NSBaselineOffsetAttributeName] };
    let objects: [&AnyObject; 4] = [font.as_ref(), theme.ink.as_ref(), paragraph.as_ref(), lift.as_ref()];
    let shown = if code.is_empty() { " " } else { code };
    unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(shown), &NSDictionary::from_slices(&keys, &objects)) }
}

fn chip_width(words: &str) -> f64 {
    let font = crate::theme::font(11.0, crate::theme::Weight::Regular);
    6.0 + 12.0 + 4.0 + crate::widgets::attributed(words, &font, &NSColor::blackColor(), None).size().width.ceil() + 6.0
}

fn header_width(language: &str, lines: usize) -> f64 {
    let pill_font = crate::theme::font(11.0, crate::theme::Weight::Medium);
    let small = crate::theme::font(11.0, crate::theme::Weight::Regular);
    let pill = crate::widgets::attributed(&markdown::language_name(language), &pill_font, &NSColor::blackColor(), None).size().width.ceil() + 14.0;
    let count = if lines > 0 { 8.0 + crate::widgets::attributed(&markdown::line_count_words(lines), &small, &NSColor::blackColor(), None).size().width.ceil() } else { 0.0 };
    12.0 + pill + count + 8.0 + chip_width("Wrap") + 4.0 + chip_width("Save") + 4.0 + chip_width("Copy") + 12.0
}

pub fn layout(source: &str, rich: bool, max: f64, wraps: &[usize], inks: &Inks, theme: &Theme) -> Layout {
    let mut builder = Builder { inks, pieces: Vec::new(), current: None, last: None, lead: 0.0, codes: 0, wraps };
    if rich {
        let frame = Frame { indent: 0.0, quotes: Vec::new(), secondary: false, gap: BLOCK_GAP };
        builder.blocks(&markdown::parse(source), &frame, 0.0, true);
    } else {
        builder.current = Some({
            let string = NSMutableAttributedString::new();
            string.appendAttributedString(&plain_text(source, inks));
            string
        });
    }
    builder.flush();
    let pieces = builder.pieces;
    let natural = |piece: &Piece, indent: f64| -> f64 {
        indent
            + match piece {
                Piece::Text { string, .. } => measure(string, HUGE).width,
                Piece::Code { language, code, .. } => (measure(&code_string(code, theme), HUGE).width + CODE_INSET * 2.0 + 2.0).max(header_width(language, markdown::line_count(code))),
                Piece::Table { text } => measure(&code_string(text, theme), HUGE).width,
                Piece::Rule => 0.0,
            }
    };
    let width = pieces.iter().map(|(piece, indent)| natural(piece, *indent)).fold(0.0, f64::max).min(max).max(1.0);
    let count = pieces.len();
    let mut placed = Vec::with_capacity(count);
    let mut y = 0.0;
    for (index, (piece, indent)) in pieces.into_iter().enumerate() {
        let room = (width - indent).max(40.0);
        let is_code = matches!(piece, Piece::Code { .. });
        let gap = match (&piece, index) {
            (Piece::Text { lead, .. }, 0) => *lead,
            (_, 0) if is_code => BLOCK_GAP,
            (_, 0) => 0.0,
            _ => BLOCK_GAP,
        };
        y += gap;
        let (height, inner) = match &piece {
            Piece::Text { string, .. } => (measure(string, room).height.max(LINE), 0.0),
            Piece::Code { code, wrap, .. } => {
                let body = if *wrap { measure(&code_string(code, theme), room - CODE_INSET * 2.0 - 2.0) } else { measure(&code_string(code, theme), HUGE) };
                (1.0 + CODE_HEADER + CODE_INSET * 2.0 + body.height + 1.0, body.width)
            }
            Piece::Table { text } => {
                let body = measure(&code_string(text, theme), HUGE);
                (body.height, body.width)
            }
            Piece::Rule => (1.0, 0.0),
        };
        placed.push(Placed { piece, x: indent, y, width: room, height, inner });
        y += height;
        if index + 1 == count && is_code {
            y += BLOCK_GAP;
        }
    }
    Layout { pieces: placed, width, height: y.max(LINE) }
}

pub struct MarkIvars {
    inset: Retained<NSColor>,
    bar: Retained<NSColor>,
}

define_class!(
    #[unsafe(super(NSLayoutManager))]
    #[ivars = MarkIvars]
    pub struct MarkLayout;

    impl MarkLayout {
        #[unsafe(method(drawBackgroundForGlyphRange:atPoint:))]
        fn draw_background(&self, glyphs: NSRange, origin: NSPoint) {
            let _: () = unsafe { msg_send![super(self), drawBackgroundForGlyphRange: glyphs, atPoint: origin] };
            self.marks(glyphs, origin);
        }
    }
);

impl MarkLayout {
    fn new(theme: &Theme) -> Retained<Self> {
        let this = Self::alloc().set_ivars(MarkIvars { inset: theme.inset.clone(), bar: theme.hairline.clone() });
        unsafe { msg_send![super(this), init] }
    }

    fn lines(&self, glyphs: NSRange, mut each: impl FnMut(NSRect, NSRange, bool)) {
        let end = glyphs.location + glyphs.length;
        let mut at = glyphs.location;
        let mut first = true;
        while at < end {
            let mut line = NSRange::new(0, 0);
            let fragment = unsafe { self.lineFragmentRectForGlyphAtIndex_effectiveRange(at, &mut line) };
            if line.length == 0 {
                break;
            }
            let start = at.max(line.location);
            let stop = end.min(line.location + line.length);
            each(fragment, NSRange::new(start, stop - start), first);
            first = false;
            at = line.location + line.length;
        }
    }

    fn marks(&self, glyphs: NSRange, origin: NSPoint) {
        let Some(storage) = (unsafe { self.textStorage() }) else { return };
        let Some(container) = self.textContainers().firstObject() else { return };
        let characters = unsafe { self.characterRangeForGlyphRange_actualGlyphRange(glyphs, std::ptr::null_mut()) };
        let code_key = key(CODE_KEY);
        let quote_key = key(QUOTE_KEY);
        let end = characters.location + characters.length;
        for (name, is_code) in [(&quote_key, false), (&code_key, true)] {
            let mut at = characters.location;
            while at < end {
                let mut found = NSRange::new(0, 0);
                let value = unsafe { storage.attribute_atIndex_longestEffectiveRange_inRange(name, at, &mut found, characters) };
                let next = (found.location + found.length).max(at + 1);
                if let Some(value) = value {
                    let run_glyphs = unsafe { self.glyphRangeForCharacterRange_actualCharacterRange(found, std::ptr::null_mut()) };
                    if is_code {
                        let height = value.downcast_ref::<NSNumber>().map_or(17.0, NSNumber::as_f64);
                        self.ivars().inset.setFill();
                        self.lines(run_glyphs, |fragment, segment, _| {
                            let bounds = self.boundingRectForGlyphRange_inTextContainer(segment, &container);
                            let top = fragment.origin.y + fragment.size.height - LINE + (LINE - height) / 2.0;
                            let area = rect(origin.x + bounds.origin.x - CODE_PAD, origin.y + top, bounds.size.width + CODE_PAD, height);
                            NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(area, 4.0, 4.0).fill();
                        });
                    } else {
                        let bars: Vec<f64> = value.downcast_ref::<NSString>().map(|text| text.to_string()).unwrap_or_default().split(',').filter_map(|x| x.parse().ok()).collect();
                        self.ivars().bar.setFill();
                        self.lines(run_glyphs, |fragment, _, first| {
                            let top = if first { fragment.origin.y + fragment.size.height - LINE } else { fragment.origin.y };
                            let bottom = fragment.origin.y + fragment.size.height;
                            for x in &bars {
                                NSBezierPath::fillRect(rect(origin.x + x, origin.y + top, QUOTE_BAR, bottom - top));
                            }
                        });
                    }
                }
                at = next;
            }
        }
    }
}

pub struct TextPart {
    pub view: Retained<NSTextView>,
    storage: Retained<NSTextStorage>,
}

pub fn text_part(mtm: MainThreadMarker, theme: &Theme, delegate: Option<&ProtocolObject<dyn NSTextViewDelegate>>) -> TextPart {
    let storage = NSTextStorage::new();
    let layout = MarkLayout::new(theme);
    let container = NSTextContainer::initWithSize(NSTextContainer::alloc(), NSSize::new(100.0, HUGE));
    container.setLineFragmentPadding(0.0);
    container.setWidthTracksTextView(true);
    layout.addTextContainer(&container);
    storage.addLayoutManager(&layout);
    let view = NSTextView::initWithFrame_textContainer(NSTextView::alloc(mtm), rect(0.0, 0.0, 100.0, LINE), Some(&container));
    view.setEditable(false);
    view.setSelectable(true);
    view.setRichText(true);
    view.setImportsGraphics(false);
    view.setDrawsBackground(false);
    view.setTextContainerInset(NSSize::new(0.0, 0.0));
    view.setVerticallyResizable(false);
    view.setHorizontallyResizable(false);
    view.setDisplaysLinkToolTips(true);
    let underline = NSNumber::new_isize(1);
    let hand = NSCursor::pointingHandCursor();
    let keys: [&NSString; 4] = unsafe { [NSForegroundColorAttributeName, NSUnderlineStyleAttributeName, NSUnderlineColorAttributeName, NSCursorAttributeName] };
    let objects: [&AnyObject; 4] = [theme.accent.as_ref(), underline.as_ref(), theme.link_line.as_ref(), hand.as_ref()];
    unsafe { view.setLinkTextAttributes(Some(&NSDictionary::from_slices(&keys, &objects))) };
    if let Some(delegate) = delegate {
        view.setDelegate(Some(delegate));
    }
    TextPart { view, storage }
}

impl TextPart {
    pub fn show(&self, string: &NSAttributedString, frame: NSRect, mine: bool, theme: &Theme) {
        let same = self.storage.isEqualToAttributedString(string);
        if !same {
            self.storage.setAttributedString(string);
            self.view.setSelectedRange(NSRange::new(0, 0));
        }
        let link = if mine { &theme.white } else { &theme.accent };
        let line = if mine { &theme.white } else { &theme.link_line };
        let underline = NSNumber::new_isize(1);
        let hand = NSCursor::pointingHandCursor();
        let keys: [&NSString; 4] = unsafe { [NSForegroundColorAttributeName, NSUnderlineStyleAttributeName, NSUnderlineColorAttributeName, NSCursorAttributeName] };
        let objects: [&AnyObject; 4] = [link.as_ref(), underline.as_ref(), line.as_ref(), hand.as_ref()];
        unsafe { self.view.setLinkTextAttributes(Some(&NSDictionary::from_slices(&keys, &objects))) };
        self.view.setFrame(frame);
        self.view.setHidden(false);
    }
}

define_class!(
    #[unsafe(super(NSScrollView))]
    #[thread_kind = MainThreadOnly]
    pub struct SideScroll;

    impl SideScroll {
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            if event.scrollingDeltaY().abs() > event.scrollingDeltaX().abs() {
                if let Some(next) = unsafe { self.nextResponder() } {
                    next.scrollWheel(event);
                }
                return;
            }
            let _: () = unsafe { msg_send![super(self), scrollWheel: event] };
        }
    }
);

impl SideScroll {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let scroll: Retained<Self> = unsafe { msg_send![Self::alloc(mtm), initWithFrame: rect(0.0, 0.0, 100.0, 40.0)] };
        scroll.setHasVerticalScroller(false);
        scroll.setHasHorizontalScroller(true);
        scroll.setAutohidesScrollers(true);
        scroll.setScrollerStyle(NSScrollerStyle::Overlay);
        scroll.setDrawsBackground(false);
        scroll
    }
}

pub struct Chip {
    icon: Retained<NSImageView>,
    words: Retained<NSTextField>,
    button: Retained<NSButton>,
}

pub struct CodeParts {
    pill: Retained<Fill>,
    pill_label: Retained<NSTextField>,
    count: Retained<NSTextField>,
    wrap: Chip,
    save: Chip,
    copy: Chip,
    scroll: Retained<SideScroll>,
    text: Retained<NSTextView>,
}

pub struct CodeIvars {
    parts: OnceCell<CodeParts>,
    code: RefCell<String>,
    language: RefCell<String>,
    key: RefCell<String>,
    chrome: Cell<bool>,
    copied: Cell<u64>,
    fill: Retained<NSColor>,
    stroke: Retained<NSColor>,
    header: Retained<NSColor>,
    header_line: Retained<NSColor>,
    ink_secondary: Retained<NSColor>,
    success: Retained<NSColor>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = CodeIvars]
    pub struct CodeBox;

    impl CodeBox {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            self.paint();
        }

        #[unsafe(method(copyCode:))]
        fn copy_code(&self, _sender: Option<&AnyObject>) {
            self.copy_now();
        }

        #[unsafe(method(saveCode:))]
        fn save_code(&self, _sender: Option<&AnyObject>) {
            self.save_now();
        }

        #[unsafe(method(wrapCode:))]
        fn wrap_code(&self, _sender: Option<&AnyObject>) {
            crate::ui::toggle_wrap(&self.ivars().key.borrow());
        }
    }
);

fn chip(mtm: MainThreadMarker, symbol: &str, words: &str, target: &CodeBox, action: Sel, theme: &Theme, spoken: &str) -> Chip {
    let icon = icon(mtm, symbol, 10.0, unsafe { NSFontWeightRegular }, &theme.ink_secondary);
    let words = label(mtm, words, &crate::theme::font(11.0, crate::theme::Weight::Regular), &theme.ink_secondary);
    let button = unsafe { NSButton::buttonWithTitle_target_action(&NSString::from_str(""), Some(target.as_ref()), Some(action), mtm) };
    button.setBordered(false);
    button.setTransparent(true);
    objc2_app_kit::NSAccessibility::setAccessibilityLabel(&*button, Some(&NSString::from_str(spoken)));
    target.addSubview(&icon);
    target.addSubview(&words);
    target.addSubview(&button);
    Chip { icon, words, button }
}

impl Chip {
    fn place(&self, right: f64, center: f64) -> f64 {
        let width = self.words.attributedStringValue().size().width.ceil() + 4.0;
        let total = 6.0 + 12.0 + 4.0 + width - 4.0 + 6.0;
        let left = right - total;
        self.icon.setFrame(rect(left + 6.0, center - 6.0, 12.0, 12.0));
        self.words.setFrame(rect(left + 6.0 + 12.0 + 4.0 - 2.0, center - 8.0, width, 16.0));
        self.button.setFrame(rect(left, center - 10.0, total, 20.0));
        left
    }

    fn set_shown(&self, shown: bool) {
        for view in [&*self.icon as &NSView, &self.words, &self.button] {
            view.setHidden(!shown);
        }
    }

    fn set(&self, symbol: &str, words: &str, tint: &NSColor) {
        if let Some(image) = crate::widgets::symbol(symbol, 10.0, unsafe { NSFontWeightRegular }) {
            self.icon.setImage(Some(&image));
        }
        self.icon.setContentTintColor(Some(tint));
        self.words.setStringValue(&NSString::from_str(words));
        self.words.setTextColor(Some(tint));
    }
}

impl CodeBox {
    pub fn new(mtm: MainThreadMarker, theme: &Theme) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(CodeIvars {
            parts: OnceCell::new(),
            code: RefCell::new(String::new()),
            language: RefCell::new(String::new()),
            key: RefCell::new(String::new()),
            chrome: Cell::new(true),
            copied: Cell::new(0),
            fill: theme.inset.clone(),
            stroke: theme.hairline_40.clone(),
            header: theme.raised_30.clone(),
            header_line: theme.hairline_30.clone(),
            ink_secondary: theme.ink_secondary.clone(),
            success: theme.success.clone(),
        });
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: rect(0.0, 0.0, 300.0, 100.0)] };
        let pill = Fill::new(mtm, Some(&theme.raised), 4.0);
        pill.set_stroke(Some(&theme.hairline_40), 1.0);
        let pill_label = label(mtm, "", &crate::theme::font(11.0, crate::theme::Weight::Medium), &theme.ink);
        pill.addSubview(&pill_label);
        view.addSubview(&pill);
        let count = label(mtm, "", &crate::theme::font(11.0, crate::theme::Weight::Regular), &theme.ink_secondary);
        view.addSubview(&count);
        let wrap = chip(mtm, "text.append", "Wrap", &view, sel!(wrapCode:), theme, "Wrap long lines");
        let save = chip(mtm, "arrow.down.to.line", "Save", &view, sel!(saveCode:), theme, "Download snippet as file");
        let copy = chip(mtm, "doc.on.doc", "Copy", &view, sel!(copyCode:), theme, "Copy code to clipboard");
        let scroll = SideScroll::new(mtm);
        let text = NSTextView::initWithFrame(NSTextView::alloc(mtm), rect(0.0, 0.0, 100.0, 40.0));
        text.setEditable(false);
        text.setSelectable(true);
        text.setRichText(true);
        text.setDrawsBackground(false);
        text.setTextContainerInset(NSSize::new(CODE_INSET, CODE_INSET));
        text.setHorizontallyResizable(true);
        text.setVerticallyResizable(false);
        text.setMaxSize(NSSize::new(HUGE, HUGE));
        if let Some(container) = unsafe { text.textContainer() } {
            container.setLineFragmentPadding(0.0);
            container.setWidthTracksTextView(false);
        }
        scroll.setDocumentView(Some(&text));
        view.addSubview(&scroll);
        view.ivars().parts.set(CodeParts { pill, pill_label, count, wrap, save, copy, scroll, text }).ok();
        view
    }

    fn paint(&self) {
        let bounds = self.bounds();
        let ivars = self.ivars();
        if !ivars.chrome.get() {
            return;
        }
        let outer = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(bounds, CODE_RADIUS, CODE_RADIUS);
        ivars.fill.setFill();
        outer.fill();
        objc2_app_kit::NSGraphicsContext::saveGraphicsState_class();
        outer.addClip();
        ivars.header.setFill();
        NSBezierPath::fillRect(rect(0.0, 0.0, bounds.size.width, CODE_HEADER));
        ivars.header_line.setFill();
        NSBezierPath::fillRect(rect(0.0, CODE_HEADER, bounds.size.width, 1.0));
        objc2_app_kit::NSGraphicsContext::restoreGraphicsState_class();
        let inset = rect(0.5, 0.5, bounds.size.width - 1.0, bounds.size.height - 1.0);
        let border = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(inset, CODE_RADIUS - 0.5, CODE_RADIUS - 0.5);
        border.setLineWidth(1.0);
        ivars.stroke.setStroke();
        border.stroke();
    }

    pub fn show(&self, placed: &Placed, key: &str, theme: &Theme) {
        let Some(parts) = self.ivars().parts.get() else { return };
        let (code, language, wrap, chrome) = match &placed.piece {
            Piece::Code { code, language, wrap, .. } => (code.clone(), language.clone(), *wrap, true),
            Piece::Table { text } => (text.clone(), String::new(), false, false),
            _ => return,
        };
        let ivars = self.ivars();
        let fresh = *ivars.code.borrow() != code || ivars.chrome.get() != chrome;
        *ivars.code.borrow_mut() = code.clone();
        *ivars.language.borrow_mut() = language.clone();
        *ivars.key.borrow_mut() = key.to_owned();
        ivars.chrome.set(chrome);
        self.setFrame(rect(placed.x, placed.y, placed.width, placed.height));
        self.setNeedsDisplay(true);
        for view in [&*parts.pill as &NSView, &parts.count] {
            view.setHidden(!chrome);
        }
        for chip in [&parts.wrap, &parts.save, &parts.copy] {
            chip.set_shown(chrome);
        }
        let width = placed.width;
        let body_top = if chrome { 1.0 + CODE_HEADER } else { 0.0 };
        let body_height = placed.height - body_top - if chrome { 1.0 } else { 0.0 };
        let side = if chrome { 1.0 } else { 0.0 };
        if chrome {
            parts.pill_label.setStringValue(&NSString::from_str(&markdown::language_name(&language)));
            let center = CODE_HEADER / 2.0;
            let lines = markdown::line_count(&code);
            parts.count.setStringValue(&NSString::from_str(&if lines > 0 { markdown::line_count_words(lines) } else { String::new() }));
            let copied = ivars.copied.get() > 0 && fresh_copy(ivars.copied.get());
            parts.copy.set(if copied { "checkmark" } else { "doc.on.doc" }, if copied { "Copied!" } else { "Copy" }, if copied { &ivars.success } else { &ivars.ink_secondary });
            parts.wrap.set("text.append", if wrap { "Unwrap" } else { "Wrap" }, if wrap { &theme.ink } else { &ivars.ink_secondary });
            objc2_app_kit::NSAccessibility::setAccessibilityLabel(&*parts.wrap.button, Some(&NSString::from_str(if wrap { "Disable line wrapping" } else { "Wrap long lines" })));
            let mut right = width - 12.0;
            right = parts.copy.place(right, center) - 4.0;
            right = parts.save.place(right, center) - 4.0;
            let buttons_left = parts.wrap.place(right, center);
            let pill_text = parts.pill_label.attributedStringValue().size().width.ceil() + 4.0;
            let count_width = parts.count.attributedStringValue().size().width.ceil() + 4.0;
            let room = (buttons_left - 8.0 - 12.0 - if lines > 0 { count_width + 8.0 } else { 0.0 }).max(30.0);
            let pill_width = (pill_text + 12.0 - 4.0 + 2.0).min(room);
            parts.pill.setFrame(rect(12.0, center - 11.0, pill_width, 22.0));
            parts.pill_label.setFrame(rect(6.0 - 2.0 + 1.0, 3.0, pill_width - 10.0, 16.0));
            parts.count.setFrame(rect(12.0 + pill_width + 8.0 - 2.0, center - 8.0, count_width, 16.0));
            parts.count.setHidden(lines == 0);
        }
        parts.scroll.setFrame(rect(side, body_top, width - side * 2.0, body_height));
        if fresh {
            if let Some(storage) = unsafe { parts.text.textStorage() } {
                storage.setAttributedString(&code_string(&code, theme));
            }
            parts.text.setSelectedRange(NSRange::new(0, 0));
        }
        let inset = if chrome { CODE_INSET } else { 0.0 };
        parts.text.setTextContainerInset(NSSize::new(inset, inset));
        let visible = width - side * 2.0;
        let content = if wrap { visible } else { (placed.inner + inset * 2.0).max(visible) };
        if let Some(container) = unsafe { parts.text.textContainer() } {
            container.setContainerSize(NSSize::new(if wrap { (visible - inset * 2.0).max(10.0) } else { HUGE }, HUGE));
        }
        parts.text.setFrame(rect(0.0, 0.0, content, body_height));
        parts.scroll.setHasHorizontalScroller(!wrap && content > visible + 0.5);
    }

    fn copy_now(&self) {
        let code = self.ivars().code.borrow().clone();
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        board.setString_forType(&NSString::from_str(&code), unsafe { NSPasteboardTypeString });
        let stamp = now_ms();
        self.ivars().copied.set(stamp);
        self.refresh_copy();
        let bound = dispatch2::MainThreadBound::new(self.retain(), self.mtm());
        let when = dispatch2::DispatchTime::try_from(std::time::Duration::from_millis(2000)).unwrap_or(dispatch2::DispatchTime::NOW);
        dispatch2::DispatchQueue::main()
            .after(when, move || {
                let Some(mtm) = MainThreadMarker::new() else { return };
                let this = bound.into_inner(mtm);
                if this.ivars().copied.get() == stamp {
                    this.ivars().copied.set(0);
                }
                this.refresh_copy();
            })
            .ok();
    }

    fn refresh_copy(&self) {
        let Some(parts) = self.ivars().parts.get() else { return };
        let ivars = self.ivars();
        let copied = ivars.copied.get() > 0 && fresh_copy(ivars.copied.get());
        parts.copy.set(if copied { "checkmark" } else { "doc.on.doc" }, if copied { "Copied!" } else { "Copy" }, if copied { &ivars.success } else { &ivars.ink_secondary });
        let right = self.bounds().size.width - 12.0;
        parts.copy.place(right, CODE_HEADER / 2.0);
    }

    fn save_now(&self) {
        let mtm = self.mtm();
        let panel = NSSavePanel::savePanel(mtm);
        panel.setNameFieldStringValue(&NSString::from_str(&markdown::snippet_file_name(&self.ivars().language.borrow())));
        if panel.runModal() != objc2_app_kit::NSModalResponseOK {
            return;
        }
        let Some(path) = panel.URL().and_then(|url| url.path()) else { return };
        std::fs::write(path.to_string(), self.ivars().code.borrow().as_bytes()).ok();
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

fn fresh_copy(stamp: u64) -> bool {
    now_ms().saturating_sub(stamp) < 2000
}

pub fn rule(mtm: MainThreadMarker, theme: &Theme) -> Retained<Fill> {
    Fill::new(mtm, Some(&theme.hairline_40), 0.0)
}

pub fn link_url(link: &AnyObject) -> Option<Retained<NSURL>> {
    let raw = if let Some(url) = link.downcast_ref::<NSURL>() { url.absoluteString()?.to_string() } else { link.downcast_ref::<NSString>()?.to_string() };
    let safe = markdown::link_target(&raw)?;
    NSURL::URLWithString(&NSString::from_str(&safe))
}
