use std::cell::{Cell, OnceCell, RefCell};
use std::io::Write;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dispatch2::{DispatchQueue, DispatchTime};
use laterdog_core::events::Frame;
use laterdog_core::store::{Changes, Connection, SendState, Store, View};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAccessibility, NSApplication, NSAutoresizingMaskOptions, NSBackingStoreType, NSButton, NSColor,
    NSControl, NSControlTextEditingDelegate, NSEventModifierFlags, NSFont, NSFontAttributeName,
    NSForegroundColorAttributeName, NSMenu, NSMenuItem, NSScrollView, NSSplitView, NSStandardKeyBindingResponding,
    NSTableColumn, NSTableColumnResizingOptions, NSTableView, NSTableViewColumnAutoresizingStyle,
    NSTableViewDataSource, NSTableViewDelegate, NSTableViewStyle, NSTextField, NSTextFieldDelegate, NSTextView,
    NSView, NSWindow, NSWindowDelegate, NSWindowStyleMask,
};
use objc2_foundation::{
    NSAttributedString, NSDictionary, NSIndexSet, NSInteger, NSMutableAttributedString, NSNotification, NSObject,
    NSObjectProtocol, NSPoint, NSRange, NSRect, NSSize, NSString,
};

use crate::net::{Home, Inbound, Lines, Post};

const SIDEBAR_WIDTH: f64 = 250.0;
const WINDOW_WIDTH: f64 = 1100.0;
const WINDOW_HEIGHT: f64 = 720.0;
const HEADER_HEIGHT: f64 = 58.0;
const COMPOSER_HEIGHT: f64 = 76.0;
const DUMP_DEADLINE: Duration = Duration::from_secs(25);
const NO_HOME_WORDS: &str = "Set LATERDOG_HOME_URL to your home's address, then open later.dog again.";

pub struct SendRequest {
    pub text: String,
    pub to: Option<String>,
}

pub struct Options {
    pub dump: bool,
    pub send: Option<SendRequest>,
}

type Style = NSDictionary<NSString, AnyObject>;

struct Styles {
    who: Retained<Style>,
    body: Retained<Style>,
    quiet: Retained<Style>,
    status: Retained<Style>,
    name: Retained<Style>,
    state: Retained<Style>,
    dot: Retained<Style>,
    no_dot: Retained<Style>,
}

impl Styles {
    fn new() -> Self {
        Styles {
            who: style(&NSFont::boldSystemFontOfSize(13.0), &NSColor::labelColor()),
            body: style(&NSFont::systemFontOfSize(14.0), &NSColor::labelColor()),
            quiet: style(&NSFont::systemFontOfSize(12.0), &NSColor::secondaryLabelColor()),
            status: style(&NSFont::systemFontOfSize(12.0), &NSColor::tertiaryLabelColor()),
            name: style(&NSFont::systemFontOfSize(13.0), &NSColor::labelColor()),
            state: style(&NSFont::systemFontOfSize(11.0), &NSColor::secondaryLabelColor()),
            dot: style(&NSFont::systemFontOfSize(9.0), &NSColor::controlAccentColor()),
            no_dot: style(&NSFont::systemFontOfSize(9.0), &NSColor::clearColor()),
        }
    }
}

fn style(font: &NSFont, color: &NSColor) -> Retained<Style> {
    let keys: [&NSString; 2] = unsafe { [NSFontAttributeName, NSForegroundColorAttributeName] };
    let objects: [&AnyObject; 2] = [font.as_ref(), color.as_ref()];
    NSDictionary::from_slices(&keys, &objects)
}

fn styled(text: &str, style: &Style) -> Retained<NSAttributedString> {
    unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(text), style) }
}

struct Ui {
    #[allow(dead_code)]
    window: Retained<NSWindow>,
    table: Retained<NSTableView>,
    transcript: Retained<NSTextView>,
    transcript_scroll: Retained<NSScrollView>,
    title: Retained<NSTextField>,
    status: Retained<NSTextField>,
    composer: Retained<NSTextField>,
    styles: Styles,
}

#[derive(Default)]
struct Dump {
    page: bool,
    framed: bool,
    frames: u64,
    composed: Option<String>,
    reply_by_stream: bool,
    finished: bool,
}

pub struct Ivars {
    store: RefCell<Store>,
    view: RefCell<View>,
    shown: RefCell<Option<String>>,
    ui: OnceCell<Ui>,
    lines: OnceCell<Lines>,
    options: Options,
    connected_home: bool,
    dump: RefCell<Dump>,
    wake_at: Cell<Option<u64>>,
}

thread_local! {
    static CONTROLLER: OnceCell<Retained<Controller>> = const { OnceCell::new() };
}

fn with_controller(work: impl FnOnce(&Controller)) {
    CONTROLLER.with(|cell| {
        if let Some(controller) = cell.get() {
            work(controller);
        }
    });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

fn on_main_after(delay: Duration, work: impl FnOnce(&Controller) + Send + 'static) {
    let when = DispatchTime::try_from(delay).unwrap_or(DispatchTime::NOW);
    DispatchQueue::main().after(when, move || with_controller(work)).ok();
}

define_class!(
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    pub struct Controller;

    unsafe impl NSObjectProtocol for Controller {}

    unsafe impl NSTableViewDataSource for Controller {
        #[unsafe(method(numberOfRowsInTableView:))]
        fn number_of_rows(&self, _table: &NSTableView) -> NSInteger {
            self.ivars().view.borrow().dogs.len() as NSInteger
        }

        #[unsafe(method_id(tableView:objectValueForTableColumn:row:))]
        fn object_value(&self, _table: &NSTableView, column: Option<&NSTableColumn>, row: NSInteger) -> Option<Retained<AnyObject>> {
            column.and_then(|column| self.cell_value(column, row))
        }
    }

    unsafe impl NSTableViewDelegate for Controller {
        #[unsafe(method(tableViewSelectionDidChange:))]
        fn selection_changed(&self, _notification: &NSNotification) {
            self.picked_row();
        }

        #[unsafe(method(tableView:shouldEditTableColumn:row:))]
        fn should_edit(&self, _table: &NSTableView, _column: Option<&NSTableColumn>, _row: NSInteger) -> bool {
            false
        }
    }

    unsafe impl NSControlTextEditingDelegate for Controller {
        #[unsafe(method(control:textView:doCommandBySelector:))]
        fn command(&self, _control: &NSControl, text_view: &NSTextView, command: Sel) -> bool {
            self.composer_command(text_view, command)
        }
    }

    unsafe impl NSTextFieldDelegate for Controller {}

    unsafe impl NSWindowDelegate for Controller {
        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            NSApplication::sharedApplication(self.mtm()).terminate(None);
        }
    }

    impl Controller {
        #[unsafe(method(send:))]
        fn send_pressed(&self, _sender: Option<&AnyObject>) {
            self.send_composer();
        }
    }
);

impl Controller {
    pub fn new(mtm: MainThreadMarker, options: Options, seed: [u8; 16], connected_home: bool) -> Retained<Self> {
        let store = Store::new(seed);
        let view = store.view();
        let this = Self::alloc(mtm).set_ivars(Ivars {
            store: RefCell::new(store),
            view: RefCell::new(view),
            shown: RefCell::new(None),
            ui: OnceCell::new(),
            lines: OnceCell::new(),
            options,
            connected_home,
            dump: RefCell::new(Dump::default()),
            wake_at: Cell::new(None),
        });
        let this: Retained<Self> = unsafe { msg_send![super(this), init] };
        CONTROLLER.with(|cell| cell.set(this.clone()).ok());
        this
    }

    pub fn connect(&self, home: Home) {
        let post: Post = std::sync::Arc::new(|inbound: Inbound| {
            DispatchQueue::main().exec_async(move || with_controller(|controller| controller.handle(inbound)));
        });
        let lines = home.start(post);
        lines.reload.send(()).ok();
        self.ivars().lines.set(lines).ok();
        if self.ivars().options.dump {
            on_main_after(DUMP_DEADLINE, |controller| controller.finish_dump(1));
        }
    }

    pub fn show(&self) {
        let mtm = self.mtm();
        let styles = Styles::new();
        let style_mask = NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Miniaturizable | NSWindowStyleMask::Resizable;
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                rect(0.0, 0.0, WINDOW_WIDTH, WINDOW_HEIGHT),
                style_mask,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setTitle(&NSString::from_str("later.dog"));
        window.setMinSize(NSSize::new(640.0, 420.0));
        window.setDelegate(Some(ProtocolObject::from_ref(self)));

        let (sidebar, table) = self.sidebar(mtm);
        let pane_width = WINDOW_WIDTH - SIDEBAR_WIDTH;
        let pane = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, pane_width, WINDOW_HEIGHT));

        let title = label(mtm, "", &NSFont::boldSystemFontOfSize(15.0), &NSColor::labelColor());
        title.setFrame(rect(16.0, WINDOW_HEIGHT - 30.0, pane_width - 32.0, 20.0));
        title.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewMinYMargin);
        pane.addSubview(&title);

        let status = label(mtm, "", &NSFont::systemFontOfSize(11.0), &NSColor::secondaryLabelColor());
        status.setFrame(rect(16.0, WINDOW_HEIGHT - 50.0, pane_width - 32.0, 16.0));
        status.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewMinYMargin);
        pane.addSubview(&status);

        let transcript_scroll = NSTextView::scrollableTextView(mtm);
        transcript_scroll.setFrame(rect(0.0, COMPOSER_HEIGHT, pane_width, WINDOW_HEIGHT - COMPOSER_HEIGHT - HEADER_HEIGHT));
        transcript_scroll.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
        let transcript = transcript_scroll
            .documentView()
            .and_then(|document| document.downcast::<NSTextView>().ok())
            .expect("a scrollable text view holds a text view");
        transcript.setEditable(false);
        transcript.setRichText(true);
        transcript.setTextContainerInset(NSSize::new(14.0, 12.0));
        transcript.setAccessibilityLabel(Some(&NSString::from_str("Conversation")));
        pane.addSubview(&transcript_scroll);

        let composer = NSTextField::initWithFrame(NSTextField::alloc(mtm), rect(14.0, 14.0, pane_width - 28.0 - 84.0, COMPOSER_HEIGHT - 28.0));
        composer.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewMaxYMargin);
        composer.setFont(Some(&NSFont::systemFontOfSize(14.0)));
        composer.setUsesSingleLineMode(false);
        if let Some(cell) = composer.cell() {
            cell.setWraps(true);
            cell.setScrollable(false);
        }
        unsafe { composer.setDelegate(Some(ProtocolObject::from_ref(self))) };
        composer.setAccessibilityLabel(Some(&NSString::from_str("Message")));
        composer.setEnabled(self.ivars().connected_home);
        pane.addSubview(&composer);

        let send = unsafe { NSButton::buttonWithTitle_target_action(&NSString::from_str("Send"), Some(self.as_ref()), Some(sel!(send:)), mtm) };
        send.setFrame(rect(pane_width - 14.0 - 76.0, 22.0, 76.0, 32.0));
        send.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinXMargin | NSAutoresizingMaskOptions::ViewMaxYMargin);
        send.setAccessibilityLabel(Some(&NSString::from_str("Send message")));
        send.setEnabled(self.ivars().connected_home);
        pane.addSubview(&send);

        let split = NSSplitView::initWithFrame(NSSplitView::alloc(mtm), rect(0.0, 0.0, WINDOW_WIDTH, WINDOW_HEIGHT));
        split.setVertical(true);
        split.setDividerStyle(objc2_app_kit::NSSplitViewDividerStyle::Thin);
        split.addArrangedSubview(&sidebar);
        split.addArrangedSubview(&pane);
        split.setHoldingPriority_forSubviewAtIndex(260.0, 0);
        window.setContentView(Some(&split));
        split.setPosition_ofDividerAtIndex(SIDEBAR_WIDTH, 0);
        window.center();
        window.makeKeyAndOrderFront(None);
        window.makeFirstResponder(Some(&composer));

        let ui = Ui { window, table, transcript, transcript_scroll, title, status, composer, styles };
        self.ivars().ui.set(ui).ok();
        self.refresh(Changes { sidebar: true, transcript: true });
    }

    fn sidebar(&self, mtm: MainThreadMarker) -> (Retained<NSScrollView>, Retained<NSTableView>) {
        let table = NSTableView::initWithFrame(NSTableView::alloc(mtm), rect(0.0, 0.0, SIDEBAR_WIDTH, WINDOW_HEIGHT));
        for (identifier, width) in [("name", SIDEBAR_WIDTH - 96.0), ("state", 72.0)] {
            let column = NSTableColumn::initWithIdentifier(NSTableColumn::alloc(mtm), &NSString::from_str(identifier));
            column.setWidth(width);
            column.setEditable(false);
            column.setResizingMask(if identifier == "name" {
                NSTableColumnResizingOptions::AutoresizingMask
            } else {
                NSTableColumnResizingOptions::empty()
            });
            table.addTableColumn(&column);
        }
        table.setHeaderView(None);
        table.setStyle(NSTableViewStyle::SourceList);
        table.setRowHeight(26.0);
        table.setColumnAutoresizingStyle(NSTableViewColumnAutoresizingStyle::FirstColumnOnlyAutoresizingStyle);
        table.setAllowsEmptySelection(false);
        table.setAccessibilityLabel(Some(&NSString::from_str("Dogs")));
        unsafe {
            table.setDataSource(Some(ProtocolObject::from_ref(self)));
            table.setDelegate(Some(ProtocolObject::from_ref(self)));
        }
        let scroll = NSScrollView::initWithFrame(NSScrollView::alloc(mtm), rect(0.0, 0.0, SIDEBAR_WIDTH, WINDOW_HEIGHT));
        scroll.setHasVerticalScroller(true);
        scroll.setDrawsBackground(false);
        scroll.setDocumentView(Some(&table));
        (scroll, table)
    }

    fn cell_value(&self, column: &NSTableColumn, row: NSInteger) -> Option<Retained<AnyObject>> {
        let styles = &self.ivars().ui.get()?.styles;
        let view = self.ivars().view.borrow();
        let dog = view.dogs.get(usize::try_from(row).ok()?)?;
        let text = NSMutableAttributedString::new();
        if column.identifier().to_string() == "name" {
            text.appendAttributedString(&styled("\u{25cf}  ", if dog.unread { &styles.dot } else { &styles.no_dot }));
            text.appendAttributedString(&styled(&dog.name, &styles.name));
        } else {
            text.appendAttributedString(&styled(dog.state, &styles.state));
        }
        let text: Retained<NSAttributedString> = Retained::into_super(text);
        Some(Retained::into_super(Retained::into_super(text)))
    }

    fn picked_row(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let row = ui.table.selectedRow();
        let picked = usize::try_from(row).ok().and_then(|row| self.ivars().view.borrow().dogs.get(row).map(|dog| dog.id.clone()));
        let Some(id) = picked else { return };
        let moved = self.ivars().store.borrow_mut().select(&id);
        if moved {
            self.refresh(Changes { sidebar: false, transcript: true });
        }
    }

    fn composer_command(&self, text_view: &NSTextView, command: Sel) -> bool {
        if command != sel!(insertNewline:) {
            return false;
        }
        let shifted = NSApplication::sharedApplication(self.mtm())
            .currentEvent()
            .is_some_and(|event| event.modifierFlags().contains(NSEventModifierFlags::Shift));
        if shifted {
            unsafe { text_view.insertNewlineIgnoringFieldEditor(None) };
        } else {
            self.send_composer();
        }
        true
    }

    fn send_composer(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let text = ui.composer.stringValue().to_string();
        if self.compose(&text) {
            ui.composer.setStringValue(&NSString::from_str(""));
        }
    }

    fn compose(&self, text: &str) -> bool {
        if self.ivars().lines.get().is_none() {
            return false;
        }
        let composed = self.ivars().store.borrow_mut().compose(text, now_ms());
        let Some(item) = composed else { return false };
        self.ivars().dump.borrow_mut().composed.get_or_insert(item.send_id);
        self.refresh(Changes { sidebar: false, transcript: true });
        self.follow_to_end();
        self.pump();
        true
    }

    fn pump(&self) {
        let now = now_ms();
        let due = self.ivars().store.borrow_mut().due(now);
        if let Some(lines) = self.ivars().lines.get() {
            for item in due {
                lines.send.send(item).ok();
            }
        }
        let Some(at) = self.ivars().store.borrow().next_wake_ms() else { return };
        if self.ivars().wake_at.get().is_some_and(|scheduled| scheduled <= at) {
            return;
        }
        self.ivars().wake_at.set(Some(at));
        on_main_after(Duration::from_millis(at.saturating_sub(now)), |controller| {
            controller.ivars().wake_at.set(None);
            controller.pump();
        });
    }

    fn handle(&self, inbound: Inbound) {
        let changes = match inbound {
            Inbound::Page(page) => {
                self.ivars().dump.borrow_mut().page = true;
                self.ivars().store.borrow_mut().apply_page(page)
            }
            Inbound::PageFailed => Changes::default(),
            Inbound::Frame(frame) => {
                let changes = self.ivars().store.borrow_mut().apply_frame(&frame);
                self.heard(&frame);
                changes
            }
            Inbound::StreamLost => self.ivars().store.borrow_mut().set_connection(Connection::Reconnecting),
            Inbound::SendDone { send_id, result } => {
                let changes = match result {
                    Ok(receipt) => self.ivars().store.borrow_mut().send_succeeded(&send_id, receipt),
                    Err(failure) => self.ivars().store.borrow_mut().send_failed(&send_id, &failure, now_ms()),
                };
                self.pump();
                changes
            }
        };
        if changes.any() {
            self.refresh(changes);
        }
        self.check_dump();
    }

    fn heard(&self, frame: &Frame) {
        let mut dump = self.ivars().dump.borrow_mut();
        dump.framed = true;
        dump.frames += 1;
        let (Frame::Message { thread_id, message } | Frame::MessagePatch { thread_id, message }) = frame else { return };
        let Some(send_id) = dump.composed.clone() else { return };
        if message.role != "bot" || message.kind != "text" || message.text.as_deref().is_none_or(str::is_empty) {
            return;
        }
        let store = self.ivars().store.borrow();
        let asked = store.thread(thread_id).iter().find(|line| line.send_id.as_deref() == Some(send_id.as_str())).map(|line| line.id.clone());
        if asked.is_some() && asked == message.parent_id {
            dump.reply_by_stream = true;
        }
    }

    fn refresh(&self, changes: Changes) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let view = self.ivars().store.borrow().view();
        *self.ivars().view.borrow_mut() = view.clone();
        let moved = *self.ivars().shown.borrow() != view.selected;
        if changes.sidebar || moved {
            ui.table.reloadData();
            let index = view.dogs.iter().position(|dog| dog.selected);
            if let Some(index) = index {
                if ui.table.selectedRow() != index as NSInteger {
                    ui.table.selectRowIndexes_byExtendingSelection(&NSIndexSet::indexSetWithIndex(index), false);
                }
            }
        }
        let status = if self.ivars().connected_home { view.status } else { "Not connected" };
        ui.status.setStringValue(&NSString::from_str(status));
        ui.title.setStringValue(&NSString::from_str(&view.title));
        let placeholder = if view.title.is_empty() { "Message".to_owned() } else { format!("Message {}", view.title) };
        ui.composer.setPlaceholderString(Some(&NSString::from_str(&placeholder)));
        if changes.transcript || moved {
            let follow = moved || self.at_bottom(ui);
            self.render_transcript(ui, &view);
            if follow {
                self.follow_to_end();
            }
        }
        *self.ivars().shown.borrow_mut() = view.selected;
    }

    fn render_transcript(&self, ui: &Ui, view: &View) {
        let styles = &ui.styles;
        let text = NSMutableAttributedString::new();
        if !self.ivars().connected_home {
            text.appendAttributedString(&styled(NO_HOME_WORDS, &styles.body));
        }
        let mut previous_quiet = true;
        for (index, row) in view.transcript.iter().enumerate() {
            if index > 0 && !(row.quiet && previous_quiet) {
                text.appendAttributedString(&styled("\n", &styles.body));
            }
            if row.quiet {
                text.appendAttributedString(&styled(&format!("{}\n", row.text), &styles.quiet));
            } else {
                text.appendAttributedString(&styled(&row.who, &styles.who));
                if let Some(status) = row.status {
                    text.appendAttributedString(&styled(&format!("  {status}"), &styles.status));
                }
                text.appendAttributedString(&styled("\n", &styles.who));
                text.appendAttributedString(&styled(&format!("{}\n", row.text), &styles.body));
            }
            previous_quiet = row.quiet;
        }
        if let Some(storage) = unsafe { ui.transcript.textStorage() } {
            storage.setAttributedString(&text);
        }
    }

    fn at_bottom(&self, ui: &Ui) -> bool {
        let visible = ui.transcript_scroll.contentView().documentVisibleRect();
        let height = ui.transcript.frame().size.height;
        visible.origin.y + visible.size.height >= height - 24.0
    }

    fn follow_to_end(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let length = ui.transcript.string().length();
        ui.transcript.scrollRangeToVisible(NSRange::new(length, 0));
    }

    fn check_dump(&self) {
        if !self.ivars().options.dump {
            return;
        }
        let (ready, composed, reply) = {
            let dump = self.ivars().dump.borrow();
            (dump.page && dump.framed, dump.composed.clone(), dump.reply_by_stream)
        };
        if !ready {
            return;
        }
        let Some(request) = &self.ivars().options.send else {
            self.finish_dump(0);
            return;
        };
        match composed {
            None => {
                let target = match &request.to {
                    Some(wanted) => self.ivars().store.borrow().find_dog(wanted),
                    None => self.ivars().store.borrow().selected().map(str::to_owned),
                };
                let Some(target) = target else {
                    eprintln!("No dog matches {:?} on this home.", request.to.as_deref().unwrap_or_default());
                    self.finish_dump(2);
                    return;
                };
                let moved = self.ivars().store.borrow_mut().select(&target);
                if moved {
                    self.refresh(Changes { sidebar: true, transcript: true });
                }
                if !self.compose(&request.text) {
                    eprintln!("The message could not be queued.");
                    self.finish_dump(2);
                }
            }
            Some(send_id) => {
                let sent = self.ivars().store.borrow().send_state(&send_id) == Some(SendState::Sent);
                if reply && sent {
                    self.finish_dump(0);
                }
            }
        }
    }

    fn finish_dump(&self, code: i32) {
        if std::mem::replace(&mut self.ivars().dump.borrow_mut().finished, true) {
            return;
        }
        let store = self.ivars().store.borrow();
        let dump = self.ivars().dump.borrow();
        let mut value = serde_json::to_value(store.view()).unwrap_or_default();
        if let Some(object) = value.as_object_mut() {
            object.insert("stream".into(), serde_json::json!({ "frames": dump.frames, "replyByStream": dump.reply_by_stream }));
            if let Some(send_id) = &dump.composed {
                let state = store.send_state(send_id).map(SendState::words);
                object.insert("sent".into(), serde_json::json!({ "sendId": send_id, "state": state }));
            }
        }
        let mut out = std::io::stdout().lock();
        writeln!(out, "{}", serde_json::to_string_pretty(&value).unwrap_or_default()).ok();
        out.flush().ok();
        std::process::exit(code);
    }
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

fn label(mtm: MainThreadMarker, text: &str, font: &NSFont, color: &NSColor) -> Retained<NSTextField> {
    let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    field.setFont(Some(font));
    field.setTextColor(Some(color));
    field
}

pub fn menu(mtm: MainThreadMarker) -> Retained<NSMenu> {
    let bar = NSMenu::new(mtm);
    let groups: [(&str, &[(&str, Sel, &str)]); 2] = [
        ("later.dog", &[("Quit later.dog", sel!(terminate:), "q")]),
        (
            "Edit",
            &[
                ("Undo", sel!(undo:), "z"),
                ("Redo", sel!(redo:), "Z"),
                ("Cut", sel!(cut:), "x"),
                ("Copy", sel!(copy:), "c"),
                ("Paste", sel!(paste:), "v"),
                ("Select All", sel!(selectAll:), "a"),
            ],
        ),
    ];
    for (title, entries) in groups {
        let holder = NSMenuItem::new(mtm);
        let submenu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(title));
        for (name, action, key) in entries {
            let item = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(name), Some(*action), &NSString::from_str(key))
            };
            submenu.addItem(&item);
        }
        holder.setSubmenu(Some(&submenu));
        bar.addItem(&holder);
    }
    bar
}
