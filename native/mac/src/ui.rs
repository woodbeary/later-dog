use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::io::Write;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dispatch2::{DispatchQueue, DispatchTime};
use laterdog_core::events::Frame;
use laterdog_core::splice::{splice, Splice};
use laterdog_core::store::{Changes, Connection, RowKind, SendState, SidebarRow, TranscriptRow, View};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAccessibility, NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication, NSBackingStoreType,
    NSBitmapImageFileType, NSButton, NSEventModifierFlags, NSFontWeightRegular, NSFontWeightMedium, NSImageView,
    NSMenu, NSMenuItem, NSScrollView, NSTableColumn, NSTableView, NSTableViewDataSource, NSTableViewDelegate, NSControlTextEditingDelegate, NSAttributedStringNSStringDrawing,
    NSTableViewSelectionHighlightStyle, NSTableViewStyle, NSTextDelegate, NSTextField, NSTextView,
    NSTextViewDelegate, NSUserInterfaceItemIdentification, NSView, NSWindow, NSWindowButton, NSWindowDelegate,
    NSWindowStyleMask, NSWindowTitleVisibility, NSTextAlignment, NSScrollElasticity, NSTableViewAnimationOptions,
};
use objc2_foundation::{
    NSCalendar, NSDate, NSDateFormatter, NSDateFormatterStyle, NSDictionary, NSIndexSet, NSInteger, NSNotification,
    NSMutableIndexSet, NSObject, NSObjectProtocol, NSPoint, NSSize, NSString,
};

use laterdog_mac::net::{Home, Inbound, Post};
use laterdog_mac::session::Session;
use crate::rich;
use crate::theme::{self, font, model_name, Theme, Weight};
use crate::widgets::{attributed, icon, icon_button, label, rect, Avatar, Fill, Flipped, ROUND};

const DUMP_DEADLINE: Duration = Duration::from_secs(25);
const NO_HOME_WORDS: &str = "Set LATERDOG_HOME_URL to your home's address, then open later.dog again.";
const DOG_CELL: &str = "dog";
const CHAT_CELL: &str = "line";

pub struct SendRequest {
    pub text: String,
    pub to: Option<String>,
}

pub struct Options {
    pub dump: bool,
    pub send: Option<SendRequest>,
    pub thread: Option<String>,
    pub history: u32,
    pub scroll_through: bool,
    pub snapshot: Option<String>,
    pub tree: bool,
    pub select: Option<String>,
    pub size: Option<(f64, f64)>,
    pub expand: bool,
    pub started: std::time::Instant,
}

impl Options {
    fn captures(&self) -> bool {
        self.snapshot.is_some() || self.tree || self.scroll_through
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Line {
    Day(u64),
    Bubble(TranscriptRow),
    Work(TranscriptRow),
    Exchange(TranscriptRow),
}

#[derive(Clone, Default)]
struct Shape {
    height: f64,
    layout: Option<Rc<rich::Layout>>,
    details: Option<(Retained<objc2_foundation::NSAttributedString>, f64, f64)>,
}

struct Ui {
    window: Retained<NSWindow>,
    root: Retained<Flipped>,
    sidebar: Retained<Fill>,
    side_line: Retained<Fill>,
    side_top: Retained<Fill>,
    side_bottom: Retained<Fill>,
    chat: Retained<Fill>,
    side_search: Retained<NSButton>,
    side_new: Retained<NSButton>,
    dog_scroll: Retained<NSScrollView>,
    dog_table: Retained<NSTableView>,
    profile: Retained<Fill>,
    profile_mark: Retained<NSTextField>,
    connect: Retained<Fill>,
    connect_label: Retained<NSTextField>,
    head_pill: Retained<Fill>,
    head_avatar: Retained<Avatar>,
    head_name: Retained<NSTextField>,
    head_search: Retained<NSButton>,
    head_more: Retained<NSButton>,
    head_status: Retained<NSTextField>,
    head_work: Retained<NSTextField>,
    chat_scroll: Retained<NSScrollView>,
    chat_table: Retained<NSTableView>,
    composer: Retained<Fill>,
    plus: Retained<NSButton>,
    input_scroll: Retained<NSScrollView>,
    input: Retained<NSTextView>,
    placeholder: Retained<NSTextField>,
    model_ring: Retained<Fill>,
    model_mark: Retained<NSImageView>,
    model_label: Retained<NSTextField>,
    model_chevrons: Retained<NSImageView>,
    mic: Retained<NSButton>,
    voice: Retained<NSButton>,
    send_fill: Retained<Fill>,
    send: Retained<NSButton>,
    days: Retained<NSDateFormatter>,
    times: Retained<NSDateFormatter>,
    weekday_times: Retained<NSDateFormatter>,
    theme: Theme,
}

#[derive(Default)]
struct Dump {
    page: bool,
    framed: bool,
    frames: u64,
    composed: Option<String>,
    reply_by_stream: bool,
    finished: bool,
    older_asked: u32,
}

pub struct Ivars {
    session: RefCell<Session>,
    view: RefCell<View>,
    shown: RefCell<Option<String>>,
    lines: RefCell<Vec<Line>>,
    shapes: RefCell<Vec<Shape>>,
    shape_cache: RefCell<HashMap<(String, u64), Shape>>,
    wraps: RefCell<HashSet<String>>,
    open_exchanges: RefCell<HashSet<String>>,
    ui: OnceCell<Ui>,
    options: Options,
    connected_home: bool,
    dump: RefCell<Dump>,
    older_pages: Cell<u32>,
    input_height: Cell<f64>,
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

fn date(at_ms: u64) -> Retained<NSDate> {
    NSDate::dateWithTimeIntervalSince1970(at_ms as f64 / 1000.0)
}

pub struct DogParts {
    selection: Retained<Fill>,
    avatar: Retained<Avatar>,
    name: Retained<NSTextField>,
    time: Retained<NSTextField>,
    preview: Retained<NSTextField>,
    dot: Retained<Fill>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = OnceCell<DogParts>]
    pub struct DogCell;

    impl DogCell {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }
    }
);

pub struct QuietParts {
    label: Retained<NSTextField>,
    face: Retained<Avatar>,
    name: Retained<NSTextField>,
    gist: Retained<NSTextField>,
    state: Retained<NSTextField>,
    chevron: Retained<NSImageView>,
    open: Retained<NSButton>,
    toggle: Retained<NSButton>,
    details: Retained<Fill>,
    text: rich::TextPart,
}

pub struct ChatParts {
    quiet: QuietParts,
    again: Retained<NSButton>,
    day: Retained<NSTextField>,
    bubble: Retained<Fill>,
    texts: RefCell<Vec<rich::TextPart>>,
    codes: RefCell<Vec<Retained<rich::CodeBox>>>,
    rules: RefCell<Vec<Retained<Fill>>>,
    status: Retained<NSTextField>,
    work: Retained<NSTextField>,
    chevron: Retained<NSImageView>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = OnceCell<ChatParts>]
    pub struct ChatCell;

    impl ChatCell {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }
    }
);

define_class!(
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    pub struct Controller;

    unsafe impl NSObjectProtocol for Controller {}

    unsafe impl NSTableViewDataSource for Controller {
        #[unsafe(method(numberOfRowsInTableView:))]
        fn number_of_rows(&self, table: &NSTableView) -> NSInteger {
            self.row_count(table)
        }
    }

    unsafe impl NSControlTextEditingDelegate for Controller {}

    unsafe impl NSTableViewDelegate for Controller {
        #[unsafe(method_id(tableView:viewForTableColumn:row:))]
        fn view_for_row(&self, table: &NSTableView, _column: Option<&NSTableColumn>, row: NSInteger) -> Option<Retained<NSView>> {
            self.cell_for(table, row)
        }

        #[unsafe(method(tableView:heightOfRow:))]
        fn height_of_row(&self, table: &NSTableView, row: NSInteger) -> f64 {
            self.row_height(table, row)
        }

        #[unsafe(method(tableViewSelectionDidChange:))]
        fn selection_changed(&self, notification: &NSNotification) {
            self.picked_row(notification);
        }
    }

    unsafe impl NSTextDelegate for Controller {
        #[unsafe(method(textDidChange:))]
        fn text_did_change(&self, _notification: &NSNotification) {
            self.input_changed();
        }
    }

    unsafe impl NSTextViewDelegate for Controller {
        #[unsafe(method(textView:doCommandBySelector:))]
        fn command(&self, _text_view: &NSTextView, command: Sel) -> bool {
            self.composer_command(command)
        }

        #[unsafe(method(textView:clickedOnLink:atIndex:))]
        fn clicked_link(&self, _text_view: &NSTextView, link: &AnyObject, _index: usize) -> bool {
            if let Some(url) = rich::link_url(link) {
                objc2_app_kit::NSWorkspace::sharedWorkspace().openURL(&url);
            }
            true
        }
    }

    unsafe impl NSWindowDelegate for Controller {
        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            NSApplication::sharedApplication(self.mtm()).terminate(None);
        }

        #[unsafe(method(windowDidResize:))]
        fn window_did_resize(&self, _notification: &NSNotification) {
            self.layout();
        }

        #[unsafe(method(windowDidBecomeKey:))]
        fn window_did_become_key(&self, _notification: &NSNotification) {
            self.ask_read();
        }
    }

    impl Controller {
        #[unsafe(method(send:))]
        fn send_pressed(&self, _sender: Option<&AnyObject>) {
            self.send_composer();
        }

        #[unsafe(method(toggleExchange:))]
        fn toggle_exchange_pressed(&self, sender: Option<&NSButton>) {
            if let Some(id) = sender.and_then(|button| button.identifier()) {
                self.toggle_exchange(&id.to_string());
            }
        }

        #[unsafe(method(sendAgain:))]
        fn send_again_pressed(&self, sender: Option<&NSButton>) {
            if let Some(send_id) = sender.and_then(|button| button.identifier()) {
                self.send_again(&send_id.to_string());
            }
        }

        #[unsafe(method(clipScrolled:))]
        fn clip_scrolled(&self, _notification: &NSNotification) {
            self.ask_older_if_near_top();
        }
    }
);

impl Controller {
    pub fn new(mtm: MainThreadMarker, options: Options, seed: [u8; 16], connected_home: bool) -> Retained<Self> {
        let session = Session::new(seed, laterdog_mac::session::data_dir());
        let view = session.store.view();
        let this = Self::alloc(mtm).set_ivars(Ivars {
            session: RefCell::new(session),
            view: RefCell::new(view),
            shown: RefCell::new(None),
            lines: RefCell::new(Vec::new()),
            shapes: RefCell::new(Vec::new()),
            shape_cache: RefCell::new(HashMap::new()),
            wraps: RefCell::new(HashSet::new()),
            open_exchanges: RefCell::new(HashSet::new()),
            ui: OnceCell::new(),
            options,
            connected_home,
            dump: RefCell::new(Dump::default()),
            older_pages: Cell::new(0),
            input_height: Cell::new(theme::COMPOSER_LINE),
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
        self.ivars().session.borrow_mut().attach(lines);
        if self.ivars().options.dump {
            on_main_after(DUMP_DEADLINE, |controller| controller.finish_dump(1));
        }
        let direct = match (&self.ivars().options.send, &self.ivars().options.thread) {
            (Some(SendRequest { text, to: Some(bot_id) }), Some(thread_id)) => Some((text.clone(), bot_id.clone(), thread_id.clone())),
            _ => None,
        };
        if let Some((text, bot_id, thread_id)) = direct {
            let item = self.ivars().session.borrow_mut().compose_to(&bot_id, &thread_id, &text, now_ms());
            if let Some(item) = item {
                self.ivars().dump.borrow_mut().composed = Some(item.send_id);
            }
        }
        self.pump();
    }

    pub fn show(&self) {
        let mtm = self.mtm();
        let theme = Theme::new();
        let (width, height) = self.ivars().options.size.unwrap_or((1280.0, 800.0));
        let style_mask = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Miniaturizable
            | NSWindowStyleMask::Resizable
            | NSWindowStyleMask::FullSizeContentView;
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(NSWindow::alloc(mtm), rect(0.0, 0.0, width, height), style_mask, NSBackingStoreType::Buffered, false)
        };
        unsafe { window.setReleasedWhenClosed(false) };
        window.setTitle(&NSString::from_str("later.dog"));
        window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
        window.setTitlebarAppearsTransparent(true);
        window.setBackgroundColor(Some(&theme.app));
        window.setMinSize(NSSize::new(720.0, 420.0));
        window.setDelegate(Some(ProtocolObject::from_ref(self)));

        let root = Flipped::new(mtm);
        let sidebar = Fill::new(mtm, Some(&theme.panel), 0.0);
        let side_line = Fill::new(mtm, Some(&theme.hairline_side), 0.0);
        let chat = Fill::new(mtm, Some(&theme.app), 0.0);
        root.addSubview(&chat);
        root.addSubview(&sidebar);
        root.addSubview(&side_line);

        let weight = unsafe { NSFontWeightRegular };
        let side_search = icon_button(mtm, "magnifyingglass", 14.0, weight, &theme.ink_secondary, "Search", None, None);
        let side_new = icon_button(mtm, "plus", 15.0, weight, &theme.ink_secondary, "New dog", None, None);

        let dog_table = self.table(mtm, "Dogs");
        let dog_scroll = scroller(mtm, &dog_table);
        dog_scroll.setAutomaticallyAdjustsContentInsets(false);
        dog_scroll.setContentInsets(objc2_foundation::NSEdgeInsets { top: theme::TOP_BAR_HEIGHT, left: 0.0, bottom: 0.0, right: 0.0 });
        sidebar.addSubview(&dog_scroll);
        let side_top = Fill::new(mtm, Some(&theme.panel), 0.0);
        let side_bottom = Fill::new(mtm, Some(&theme.panel), 0.0);
        sidebar.addSubview(&side_top);
        sidebar.addSubview(&side_bottom);

        let profile = Fill::new(mtm, Some(&theme.raised), ROUND);
        let profile_mark = label(mtm, "?", &font(12.16, Weight::Medium), &theme.ink_secondary);
        profile_mark.setAlignment(NSTextAlignment::Center);
        profile.addSubview(&profile_mark);
        profile.setAccessibilityLabel(Some(&NSString::from_str("Profile")));
        let connect = Fill::new(mtm, None, ROUND);
        connect.set_stroke(Some(&theme.hairline_pill), 1.0);
        let connect_label = label(mtm, "Connect apps", &font(13.5, Weight::Medium), &theme.ink);
        connect_label.setAlignment(NSTextAlignment::Center);
        connect.addSubview(&connect_label);
        sidebar.addSubview(&profile);
        sidebar.addSubview(&connect);
        sidebar.addSubview(&side_search);
        sidebar.addSubview(&side_new);

        let chat_table = self.table(mtm, "Conversation");
        let chat_scroll = scroller(mtm, &chat_table);
        chat.addSubview(&chat_scroll);
        let clip = chat_scroll.contentView();
        clip.setPostsBoundsChangedNotifications(true);
        unsafe {
            objc2_foundation::NSNotificationCenter::defaultCenter().addObserver_selector_name_object(
                self,
                sel!(clipScrolled:),
                Some(objc2_app_kit::NSViewBoundsDidChangeNotification),
                Some(&clip),
            );
        }

        let head_pill = Fill::new(mtm, Some(&theme.composer), ROUND);
        head_pill.set_stroke(Some(&theme.head_ring), theme::HAIRLINE);
        let head_avatar = Avatar::new(mtm);
        let head_name = label(mtm, "", &font(14.0, Weight::Semibold), &theme.ink);
        head_pill.addSubview(&head_avatar);
        head_pill.addSubview(&head_name);
        let head_search = icon_button(mtm, "magnifyingglass", 15.0, weight, &theme.ink_secondary, "Find in conversation", None, None);
        let head_more = icon_button(mtm, "ellipsis", 15.0, weight, &theme.ink_secondary, "More", None, None);
        let head_status = label(mtm, "", &font(12.0, Weight::Regular), &theme.ink_secondary);
        head_status.setAlignment(NSTextAlignment::Center);
        chat.addSubview(&head_pill);
        chat.addSubview(&head_search);
        chat.addSubview(&head_more);
        chat.addSubview(&head_status);
        let head_work = label(mtm, "", &font(12.0, Weight::Regular), &theme.ink_secondary);
        head_work.setHidden(true);
        chat.addSubview(&head_work);

        let composer = Fill::new(mtm, Some(&theme.composer), theme::COMPOSER_RADIUS);
        composer.set_stroke(Some(&theme.composer_ring), theme::HAIRLINE);
        let plus = icon_button(mtm, "plus", 15.0, weight, &theme.ink_secondary, "Add", None, None);
        let input_scroll = NSTextView::scrollableTextView(mtm);
        input_scroll.setDrawsBackground(false);
        input_scroll.setHasVerticalScroller(false);
        input_scroll.setVerticalScrollElasticity(NSScrollElasticity::None);
        let input = input_scroll
            .documentView()
            .and_then(|document| document.downcast::<NSTextView>().ok())
            .expect("a scrollable text view holds a text view");
        input.setDrawsBackground(false);
        input.setRichText(false);
        input.setFont(Some(&font(14.0, Weight::Regular)));
        input.setTextColor(Some(&theme.ink));
        input.setInsertionPointColor(Some(&theme.ink));
        input.setTextContainerInset(NSSize::new(0.0, 0.0));
        if let Some(container) = unsafe { input.textContainer() } {
            container.setLineFragmentPadding(0.0);
        }
        let typing = attributed(" ", &font(14.0, Weight::Regular), &theme.ink, Some((theme::COMPOSER_LINE, 0.0)));
        let typing_attributes = unsafe { typing.attributesAtIndex_effectiveRange(0, std::ptr::null_mut()) };
        unsafe { input.setTypingAttributes(&typing_attributes) };
        input.setDelegate(Some(ProtocolObject::from_ref(self)));
        input.setAccessibilityLabel(Some(&NSString::from_str("Message")));
        let placeholder = label(mtm, "Message", &font(14.0, Weight::Regular), &theme.ink_secondary);
        let model_ring = Fill::new(mtm, None, ROUND);
        model_ring.set_stroke(Some(&theme::srgb(0x38d591, 1.0)), 2.0);
        let model_mark = icon(mtm, "asterisk", 10.0, unsafe { NSFontWeightMedium }, &theme::srgb(0xd97757, 1.0));
        let model_label = label(mtm, "", &font(13.0, Weight::Medium), &theme.ink);
        let model_chevrons = icon(mtm, "chevron.up.chevron.down", 9.0, weight, &theme.ink_tertiary);
        let mic = icon_button(mtm, "mic", 15.0, weight, &theme.ink_secondary, "Dictate", None, None);
        let voice = icon_button(mtm, "waveform", 15.0, weight, &theme.ink_secondary, "Talk", None, None);
        let send_fill = Fill::new(mtm, Some(&theme.raised), ROUND);
        let send = icon_button(mtm, "arrow.up", 14.0, unsafe { NSFontWeightMedium }, &theme.ink_tertiary, "Send message", Some(self.as_ref()), Some(sel!(send:)));
        for view in [&*plus as &NSView, &input_scroll, &placeholder, &model_ring, &model_mark, &model_label, &model_chevrons, &mic, &voice, &send_fill, &send] {
            composer.addSubview(view);
        }
        chat.addSubview(&composer);
        let enabled = self.ivars().connected_home;
        input.setEditable(enabled);
        send.setEnabled(enabled);

        let days = NSDateFormatter::new();
        days.setDateStyle(NSDateFormatterStyle::MediumStyle);
        days.setTimeStyle(NSDateFormatterStyle::NoStyle);
        days.setDoesRelativeDateFormatting(true);
        let times = NSDateFormatter::new();
        times.setDateStyle(NSDateFormatterStyle::NoStyle);
        times.setTimeStyle(NSDateFormatterStyle::ShortStyle);
        let weekday_times = NSDateFormatter::new();
        weekday_times.setLocalizedDateFormatFromTemplate(&NSString::from_str("EEEjmm"));

        window.setContentView(Some(&root));
        let ui = Ui {
            window, root, sidebar, side_line, side_top, side_bottom, chat, side_search, side_new, dog_scroll, dog_table, profile, profile_mark, connect,
            connect_label, head_pill, head_avatar, head_name, head_search, head_more, head_status, head_work, chat_scroll, chat_table, composer,
            plus, input_scroll, input, placeholder, model_ring, model_mark, model_label, model_chevrons, mic, voice, send_fill, send,
            days, times, weekday_times, theme,
        };
        self.ivars().ui.set(ui).ok();
        self.layout();
        let Some(ui) = self.ivars().ui.get() else { return };
        ui.window.center();
        if !self.ivars().options.captures() {
            ui.window.makeKeyAndOrderFront(None);
            ui.window.makeFirstResponder(Some(&ui.input));
        }
        self.refresh(Changes { sidebar: true, transcript: true });
    }

    fn table(&self, mtm: MainThreadMarker, name: &str) -> Retained<NSTableView> {
        let table = NSTableView::initWithFrame(NSTableView::alloc(mtm), rect(0.0, 0.0, 100.0, 100.0));
        let column = NSTableColumn::initWithIdentifier(NSTableColumn::alloc(mtm), &NSString::from_str("main"));
        table.addTableColumn(&column);
        table.setHeaderView(None);
        table.setStyle(NSTableViewStyle::Plain);
        table.setSelectionHighlightStyle(NSTableViewSelectionHighlightStyle::None);
        table.setIntercellSpacing(NSSize::new(0.0, 0.0));
        table.setBackgroundColor(&objc2_app_kit::NSColor::clearColor());
        table.setColumnAutoresizingStyle(objc2_app_kit::NSTableViewColumnAutoresizingStyle::FirstColumnOnlyAutoresizingStyle);
        table.setAccessibilityLabel(Some(&NSString::from_str(name)));
        unsafe {
            table.setDataSource(Some(ProtocolObject::from_ref(self)));
            table.setDelegate(Some(ProtocolObject::from_ref(self)));
        }
        table
    }

    fn is_dogs(&self, table: &NSTableView) -> bool {
        self.ivars().ui.get().is_some_and(|ui| std::ptr::eq(table, &*ui.dog_table))
    }

    fn row_count(&self, table: &NSTableView) -> NSInteger {
        if self.is_dogs(table) {
            self.ivars().view.borrow().dogs.len() as NSInteger
        } else {
            self.ivars().lines.borrow().len() as NSInteger
        }
    }

    fn row_height(&self, table: &NSTableView, row: NSInteger) -> f64 {
        if self.is_dogs(table) {
            return theme::ROW_HEIGHT + theme::ROW_GAP;
        }
        let gap = if row > 0 { theme::TRANSCRIPT_GAP } else { 0.0 };
        let height = usize::try_from(row).ok().and_then(|row| self.ivars().shapes.borrow().get(row).map(|shape| shape.height)).unwrap_or_default();
        (height + gap).max(1.0)
    }

    fn cell_for(&self, table: &NSTableView, row: NSInteger) -> Option<Retained<NSView>> {
        let ui = self.ivars().ui.get()?;
        let index = usize::try_from(row).ok()?;
        let mtm = self.mtm();
        let width = table.bounds().size.width;
        if self.is_dogs(table) {
            let reused = unsafe { table.makeViewWithIdentifier_owner(&NSString::from_str(DOG_CELL), None) };
            let cell = match reused.and_then(|view| view.downcast::<DogCell>().ok()) {
                Some(cell) => cell,
                None => new_dog_cell(mtm, &ui.theme),
            };
            let view = self.ivars().view.borrow();
            let dog = view.dogs.get(index)?;
            configure_dog(&cell, dog, width, ui);
            return Some(Retained::into_super(cell));
        }
        let reused = unsafe { table.makeViewWithIdentifier_owner(&NSString::from_str(CHAT_CELL), None) };
        let cell = match reused.and_then(|view| view.downcast::<ChatCell>().ok()) {
            Some(cell) => cell,
            None => new_chat_cell(mtm, &ui.theme, Some(self.as_ref())),
        };
        let lines = self.ivars().lines.borrow();
        let line = lines.get(index)?;
        let shape = self.ivars().shapes.borrow().get(index).cloned().unwrap_or_default();
        let gap = if index > 0 { theme::TRANSCRIPT_GAP } else { 0.0 };
        let color = self.ivars().view.borrow().color.clone();
        configure_line(&cell, line, &shape, gap, width, &color, ui, self);
        Some(Retained::into_super(cell))
    }

    fn picked_row(&self, notification: &NSNotification) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let from_dogs = notification.object().is_some_and(|object| std::ptr::eq(&*object as *const AnyObject as *const NSTableView, &*ui.dog_table));
        if !from_dogs {
            return;
        }
        let row = ui.dog_table.selectedRow();
        let picked = usize::try_from(row).ok().and_then(|row| self.ivars().view.borrow().dogs.get(row).map(|dog| dog.id.clone()));
        let Some(id) = picked else { return };
        let moved = self.ivars().session.borrow_mut().store.select(&id);
        if moved {
            self.refresh(Changes { sidebar: true, transcript: true });
        }
    }

    fn layout(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        place_traffic_lights(&ui.window);
        let bounds = ui.root.bounds();
        let (width, height) = (bounds.size.width, bounds.size.height);
        let side = theme::SIDEBAR_WIDTH.min(width / 2.0);
        ui.sidebar.setFrame(rect(0.0, 0.0, side, height));
        ui.side_line.setFrame(rect(side - 1.0, 0.0, 1.0, height));
        ui.chat.setFrame(rect(side, 0.0, width - side, height));

        let button = theme::ICON_BUTTON;
        let top_center = theme::TRAFFIC_LIGHT_CENTER_Y;
        ui.side_new.setFrame(rect(side - 8.0 - button, top_center - button / 2.0, button, button));
        ui.side_search.setFrame(rect(side - 8.0 - button * 2.0 - 2.0, top_center - button / 2.0, button, button));
        let footer_top = height - theme::FOOTER_PAD_BOTTOM - theme::FOOTER_HEIGHT;
        ui.profile.setFrame(rect(theme::FOOTER_PAD_X + 2.0, footer_top + 2.0, 32.0, 32.0));
        ui.profile_mark.setFrame(rect(0.0, 8.0, 32.0, 16.0));
        let connect_x = theme::FOOTER_PAD_X + theme::FOOTER_HEIGHT + theme::FOOTER_GAP;
        let connect_width = side - 1.0 - theme::FOOTER_PAD_X - connect_x;
        ui.connect.setFrame(rect(connect_x, footer_top, connect_width, theme::FOOTER_HEIGHT));
        ui.connect_label.setFrame(rect(8.0, 9.0, connect_width - 16.0, 18.0));
        let list_bottom = footer_top - theme::FOOTER_PAD_TOP;
        ui.dog_scroll.setFrame(rect(0.0, 0.0, side - 1.0, list_bottom));
        ui.side_top.setFrame(rect(0.0, 0.0, side - 1.0, theme::TOP_BAR_HEIGHT));
        ui.side_bottom.setFrame(rect(0.0, list_bottom, side - 1.0, height - list_bottom));
        for scroll in [&ui.dog_scroll, &ui.chat_scroll] {
            scroll.setScrollerStyle(objc2_app_kit::NSScrollerStyle::Overlay);
        }

        let chat_width = width - side;
        let icon = theme::HEADER_ICON_BUTTON;
        let head_center = theme::HEADER_PAD_Y + 18.0;
        ui.head_more.setFrame(rect(chat_width - theme::HEADER_PAD_X - icon, head_center - icon / 2.0, icon, icon));
        ui.head_search.setFrame(rect(chat_width - theme::HEADER_PAD_X - icon * 2.0 - 8.0, head_center - icon / 2.0, icon, icon));
        let name_width = ui.head_name.attributedStringValue().size().width.ceil() + 4.0;
        let pill_width = theme::HEADER_PILL_PAD + theme::HEADER_AVATAR + 8.0 + name_width + theme::HEADER_PILL_PAD_RIGHT;
        let pill_height = theme::HEADER_AVATAR + theme::HEADER_PILL_PAD * 2.0;
        let controls = theme::HEADER_PAD_X + icon * 2.0 + 8.0 + 8.0;
        let work_room = (chat_width - controls * 2.0 - pill_width - 8.0).max(0.0);
        let work_width = if ui.head_work.isHidden() { 0.0 } else { (ui.head_work.attributedStringValue().size().width.ceil() + 4.0).min(work_room) };
        let group = pill_width + if work_width > 0.0 { 8.0 + work_width } else { 0.0 };
        let pill_x = ((chat_width - group) / 2.0).round();
        ui.head_pill.setFrame(rect(pill_x, theme::HEADER_PAD_Y, pill_width, pill_height));
        ui.head_work.setFrame(rect(pill_x + pill_width + 8.0 - 2.0, theme::HEADER_PAD_Y + (pill_height - 16.0) / 2.0, work_width, 16.0));
        ui.head_avatar.setFrame(rect(theme::HEADER_PILL_PAD, theme::HEADER_PILL_PAD, theme::HEADER_AVATAR, theme::HEADER_AVATAR));
        ui.head_name.setFrame(rect(theme::HEADER_PILL_PAD + theme::HEADER_AVATAR + 8.0, (pill_height - 18.0) / 2.0, name_width, 18.0));
        let head_bottom = theme::HEADER_PAD_Y * 2.0 + pill_height;
        ui.head_status.setFrame(rect(theme::HEADER_PAD_X, head_bottom - 6.0, chat_width - theme::HEADER_PAD_X * 2.0, 16.0));

        let text_height = self.ivars().input_height.get();
        let inner = (text_height + 8.0).max(theme::COMPOSER_CONTROL);
        let shell_height = inner + theme::COMPOSER_INSET_Y * 2.0;
        let shell_width = chat_width - theme::COMPOSER_PAD_X * 2.0;
        let shell_top = height - theme::COMPOSER_PAD_BOTTOM - shell_height;
        ui.composer.setFrame(rect(theme::COMPOSER_PAD_X, shell_top, shell_width, shell_height));
        let control = theme::COMPOSER_CONTROL;
        let control_y = shell_height - theme::COMPOSER_INSET_Y - control;
        ui.plus.setFrame(rect(theme::COMPOSER_INSET_X, control_y, control, control));
        let send_x = shell_width - theme::COMPOSER_INSET_X - control;
        ui.send_fill.setFrame(rect(send_x, control_y, control, control));
        ui.send.setFrame(rect(send_x, control_y, control, control));
        let voice_x = send_x - 4.0 - control;
        ui.voice.setFrame(rect(voice_x, control_y, control, control));
        let mic_x = voice_x - 4.0 - control;
        ui.mic.setFrame(rect(mic_x, control_y, control, control));
        let model_text = ui.model_label.attributedStringValue().size().width.ceil() + 4.0;
        let picker_right = mic_x - 4.0 - 8.0;
        let chevrons_x = picker_right - 12.0;
        ui.model_chevrons.setFrame(rect(chevrons_x, control_y + 10.0, 12.0, 12.0));
        let model_x = chevrons_x - 6.0 - model_text;
        ui.model_label.setFrame(rect(model_x, control_y + 7.0, model_text, 18.0));
        let ring_x = model_x - 6.0 - 22.0;
        ui.model_ring.setFrame(rect(ring_x, control_y + 5.0, 22.0, 22.0));
        ui.model_mark.setFrame(rect(ring_x, control_y + 5.0, 22.0, 22.0));
        let input_x = theme::COMPOSER_INSET_X + control + 4.0 + 4.0;
        let input_width = (ring_x - 8.0 - input_x).max(40.0);
        let input_y = theme::COMPOSER_INSET_Y + 4.0 + (inner - 8.0 - text_height).max(0.0) / 2.0;
        ui.input_scroll.setFrame(rect(input_x, input_y, input_width, text_height));
        ui.placeholder.setFrame(rect(input_x - 2.0, input_y + 1.0, input_width, 18.0));

        let transcript_top = head_bottom;
        let transcript_bottom = shell_top - 8.0;
        let before = ui.chat_scroll.frame().size.width;
        let scroller_room = if ui.chat_scroll.scrollerStyle() == objc2_app_kit::NSScrollerStyle::Legacy {
            objc2_app_kit::NSScroller::scrollerWidthForControlSize_scrollerStyle(objc2_app_kit::NSControlSize::Regular, objc2_app_kit::NSScrollerStyle::Legacy, self.mtm())
        } else {
            0.0
        };
        ui.chat_scroll.setFrame(rect(theme::TRANSCRIPT_PAD_X, transcript_top, chat_width - theme::TRANSCRIPT_PAD_X * 2.0 + scroller_room.min(theme::TRANSCRIPT_PAD_X), (transcript_bottom - transcript_top).max(40.0)));
        if (before - ui.chat_scroll.frame().size.width).abs() > 0.5 {
            self.reshape(true);
        }
    }

    fn reshape(&self, reload: bool) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let width = ui.chat_scroll.contentSize().width;
        let max_bubble = theme::BUBBLE_MAX.min(width * theme::BUBBLE_MAX_SHARE);
        let max_text = (max_bubble - theme::BUBBLE_PAD_X * 2.0).max(40.0);
        let old = std::mem::take(&mut *self.ivars().shape_cache.borrow_mut());
        let mut kept = HashMap::new();
        let shapes: Vec<Shape> = self.ivars().lines.borrow().iter().map(|line| self.shape(line, max_text, ui, &old, &mut kept)).collect();
        *self.ivars().shape_cache.borrow_mut() = kept;
        *self.ivars().shapes.borrow_mut() = shapes;
        if reload {
            ui.chat_table.reloadData();
        }
    }

    fn shape(&self, line: &Line, max_text: f64, ui: &Ui, old: &HashMap<(String, u64), Shape>, kept: &mut HashMap<(String, u64), Shape>) -> Shape {
        match line {
            Line::Day(_) => Shape { height: theme::DAY_PAD_Y * 2.0 + theme::DAY_LINE, ..Shape::default() },
            Line::Work(_) => Shape { height: theme::WORK_HEIGHT, ..Shape::default() },
            Line::Exchange(row) => {
                let Some(exchange) = row.exchange.as_ref().filter(|_| self.ivars().options.expand != self.ivars().open_exchanges.borrow().contains(&row.id)) else {
                    return Shape { height: theme::QUIET_LINE, ..Shape::default() };
                };
                let theme = &ui.theme;
                let details = &exchange.details;
                let mut lines = vec![(details.heading.clone(), theme.ink_tertiary.clone(), false, 0.0)];
                lines.push((laterdog_core::words::EXCHANGE_REQUEST.to_owned(), theme.ink.clone(), true, 6.0));
                lines.push((details.request.clone(), theme.ink_secondary.clone(), false, 0.0));
                lines.push((laterdog_core::words::EXCHANGE_REPLY.to_owned(), theme.ink.clone(), true, 6.0));
                match &details.reply {
                    Some(reply) => lines.push((reply.clone(), theme.ink_secondary.clone(), false, 0.0)),
                    None => lines.push((laterdog_core::words::EXCHANGE_NO_REPLY.to_owned(), theme.ink_tertiary.clone(), false, 0.0)),
                }
                for extra in [&details.waiting, &details.ended].into_iter().flatten() {
                    lines.push((extra.clone(), theme.ink_secondary.clone(), false, 6.0));
                }
                let string = rich::lines_text(&lines);
                let full = ui.chat_scroll.contentSize().width;
                let box_width = theme::EXCHANGE_DETAILS_MAX.min(full);
                let size = rich::measure_at(&string, box_width - 18.0);
                let box_height = size.height + 18.0;
                Shape { height: theme::QUIET_LINE + 6.0 + box_height, layout: None, details: Some((string, box_width, box_height)) }
            }
            Line::Bubble(row) => {
                let wraps = self.wraps_for(&row.id);
                let key = (format!("{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{:?}", row.id, row.text, row.status.unwrap_or_default(), row.mine, wraps), max_text.to_bits());
                if let Some(shape) = kept.get(&key).or_else(|| old.get(&key)) {
                    let shape = shape.clone();
                    kept.insert(key, shape.clone());
                    return shape;
                }
                let inks = if row.mine { rich::Inks::mine(&ui.theme) } else { rich::Inks::reply(&ui.theme) };
                let layout = rich::layout(&row.text, !row.mine, max_text, &wraps, &inks, &ui.theme);
                let status = if matches!(row.status, Some(words) if words != SendState::Sent.words()) { 18.0 } else { 0.0 };
                let shape = Shape { height: layout.height + theme::BUBBLE_PAD_Y * 2.0 + status, layout: Some(Rc::new(layout)), details: None };
                kept.insert(key, shape.clone());
                shape
            }
        }
    }

    fn wraps_for(&self, row_id: &str) -> Vec<usize> {
        let prefix = format!("{row_id}#");
        let mut found: Vec<usize> = self.ivars().wraps.borrow().iter().filter_map(|key| key.strip_prefix(&prefix)?.parse().ok()).collect();
        found.sort_unstable();
        found
    }

    fn toggle_exchange(&self, id: &str) {
        {
            let mut open = self.ivars().open_exchanges.borrow_mut();
            if !open.remove(id) {
                open.insert(id.to_owned());
            }
        }
        let Some(ui) = self.ivars().ui.get() else { return };
        let index = self.ivars().lines.borrow().iter().position(|line| matches!(line, Line::Exchange(row) if row.id == id));
        self.reshape(false);
        if let Some(index) = index {
            let set = NSIndexSet::indexSetWithIndex(index);
            ui.chat_table.noteHeightOfRowsWithIndexesChanged(&set);
            ui.chat_table.reloadDataForRowIndexes_columnIndexes(&set, &NSIndexSet::indexSetWithIndex(0));
        }
    }

    fn toggle_wrap(&self, key: &str) {
        {
            let mut wraps = self.ivars().wraps.borrow_mut();
            if !wraps.remove(key) {
                wraps.insert(key.to_owned());
            }
        }
        let Some(ui) = self.ivars().ui.get() else { return };
        let row_id = key.rsplit_once('#').map_or(key, |(id, _)| id);
        let index = self.ivars().lines.borrow().iter().position(|line| matches!(line, Line::Bubble(row) if row.id == row_id));
        self.reshape(false);
        if let Some(index) = index {
            let set = NSIndexSet::indexSetWithIndex(index);
            ui.chat_table.noteHeightOfRowsWithIndexesChanged(&set);
            ui.chat_table.reloadDataForRowIndexes_columnIndexes(&set, &NSIndexSet::indexSetWithIndex(0));
        }
    }

    fn lines_for(&self, view: &View, ui: &Ui) -> Vec<Line> {
        let calendar = NSCalendar::currentCalendar();
        let mut lines = Vec::new();
        let mut previous: Option<u64> = None;
        for row in &view.transcript {
            let new_day = match previous {
                None => true,
                Some(before) => !calendar.isDate_inSameDayAsDate(&date(before), &date(row.at)),
            };
            if new_day && row.at > 0 {
                lines.push(Line::Day(row.at));
            }
            previous = Some(row.at);
            lines.push(match row.kind {
                RowKind::Work => Line::Work(row.clone()),
                RowKind::Exchange => Line::Exchange(row.clone()),
                RowKind::Text => Line::Bubble(row.clone()),
            });
        }
        let _ = ui;
        lines
    }

    fn send_composer(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let text = ui.input.string().to_string();
        if self.compose(&text) {
            ui.input.setString(&NSString::from_str(""));
            self.input_changed();
        }
    }

    fn composer_command(&self, command: Sel) -> bool {
        if command != sel!(insertNewline:) {
            return false;
        }
        let shifted = NSApplication::sharedApplication(self.mtm())
            .currentEvent()
            .is_some_and(|event| event.modifierFlags().intersects(NSEventModifierFlags::Shift | NSEventModifierFlags::Option));
        if shifted {
            return false;
        }
        self.send_composer();
        true
    }

    fn input_changed(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let empty = ui.input.string().length() == 0;
        ui.placeholder.setHidden(!empty);
        let has_words = !ui.input.string().to_string().trim().is_empty();
        ui.send_fill.set_fill(Some(if has_words { &ui.theme.accent } else { &ui.theme.raised }));
        ui.send.setContentTintColor(Some(if has_words { &ui.theme.accent_ink } else { &ui.theme.ink_tertiary }));
        let used = match (unsafe { ui.input.layoutManager() }, unsafe { ui.input.textContainer() }) {
            (Some(layout), Some(container)) => {
                layout.ensureLayoutForTextContainer(&container);
                layout.usedRectForTextContainer(&container).size.height
            }
            _ => theme::COMPOSER_LINE,
        };
        let height = used.clamp(theme::COMPOSER_LINE, theme::COMPOSER_MAX_TEXT);
        if (height - self.ivars().input_height.get()).abs() > 0.5 {
            self.ivars().input_height.set(height);
            let follow = self.at_bottom(ui);
            self.layout();
            if follow {
                self.follow_to_end();
            }
        }
    }

    fn compose(&self, text: &str) -> bool {
        if !self.ivars().session.borrow().connected() {
            return false;
        }
        let composed = self.ivars().session.borrow_mut().compose(text, now_ms());
        let Some(item) = composed else { return false };
        self.ivars().dump.borrow_mut().composed.get_or_insert(item.send_id);
        self.refresh(Changes { sidebar: true, transcript: true });
        self.follow_to_end();
        self.pump();
        true
    }

    fn pump(&self) {
        let now = now_ms();
        let wake = self.ivars().session.borrow_mut().pump(now);
        if let Some(at) = wake {
            on_main_after(Duration::from_millis(at.saturating_sub(now)), |controller| {
                controller.ivars().session.borrow_mut().woke();
                controller.pump();
            });
        }
    }

    fn send_again(&self, send_id: &str) {
        if self.ivars().session.borrow_mut().send_again(send_id) {
            self.refresh(Changes { sidebar: false, transcript: true });
            self.pump();
        }
    }

    fn ask_read(&self) {
        let looking = self.ivars().ui.get().is_some_and(|ui| ui.window.isKeyWindow());
        self.ivars().session.borrow_mut().ask_read(looking);
    }

    fn ask_older_if_near_top(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let visible = ui.chat_scroll.contentView().documentVisibleRect();
        let content = ui.chat_table.frame().size.height;
        let near_top = visible.origin.y <= 80.0 || content <= visible.size.height;
        if near_top {
            self.ivars().session.borrow_mut().ask_older();
        }
    }

    fn list_to_top(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let clip = ui.dog_scroll.contentView();
        clip.scrollToPoint(objc2_foundation::NSPoint::new(0.0, -theme::TOP_BAR_HEIGHT));
        ui.dog_scroll.reflectScrolledClipView(&clip);
    }

    fn handle(&self, inbound: Inbound) {
        let first_page = matches!(inbound, Inbound::Page(_)) && !std::mem::replace(&mut self.ivars().dump.borrow_mut().page, true);
        let heard = match &inbound {
            Inbound::Frame(frame) => Some(frame.clone()),
            _ => None,
        };
        if matches!(inbound, Inbound::Older { .. }) {
            self.ivars().older_pages.set(self.ivars().older_pages.get() + 1);
        }
        let changes = self.ivars().session.borrow_mut().handle(inbound, now_ms());
        if let Some(frame) = heard {
            self.heard(&frame);
        }
        if first_page {
            laterdog_mac::timing::mark("first page applied");
            self.refresh(changes);
            self.list_to_top();
            self.select_wanted();
            if self.ivars().options.captures() {
                self.capture_soon();
                return;
            }
        } else if changes.any() {
            self.refresh(changes);
        }
        self.pump();
        self.ask_read();
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
        let session = self.ivars().session.borrow();
        let asked = session.store.thread(thread_id).iter().find(|line| line.send_id.as_deref() == Some(send_id.as_str())).map(|line| line.id.clone());
        if asked.is_some() && asked == message.parent_id {
            dump.reply_by_stream = true;
        }
    }

    fn refresh(&self, changes: Changes) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let view = self.ivars().session.borrow().store.view();
        *self.ivars().view.borrow_mut() = view.clone();
        let moved = *self.ivars().shown.borrow() != view.selected;
        if changes.sidebar || moved {
            ui.dog_table.reloadData();
            if let Some(index) = view.dogs.iter().position(|dog| dog.selected) {
                if ui.dog_table.selectedRow() != index as NSInteger {
                    ui.dog_table.selectRowIndexes_byExtendingSelection(&NSIndexSet::indexSetWithIndex(index), false);
                }
            }
        }
        self.refresh_header(ui, &view);
        if changes.transcript || moved {
            let follow = moved || self.at_bottom(ui);
            let lines = if self.ivars().connected_home { self.lines_for(&view, ui) } else { Vec::new() };
            let old = std::mem::replace(&mut *self.ivars().lines.borrow_mut(), lines.clone());
            let plan = if moved { Splice::Reload } else { splice(&old, &lines) };
            let rows = |indexes: &mut dyn Iterator<Item = usize>| {
                let set = NSMutableIndexSet::new();
                for index in indexes {
                    set.addIndex(index);
                }
                set
            };
            let total = |shapes: &[Shape]| shapes.iter().enumerate().map(|(index, shape)| shape.height + if index > 0 { theme::TRANSCRIPT_GAP } else { 0.0 }).sum::<f64>();
            match plan {
                Splice::Nothing => {}
                Splice::Reload => self.reshape(true),
                Splice::Rows(changed) => {
                    self.reshape(false);
                    let set = rows(&mut changed.into_iter());
                    ui.chat_table.noteHeightOfRowsWithIndexesChanged(&set);
                    ui.chat_table.reloadDataForRowIndexes_columnIndexes(&set, &NSIndexSet::indexSetWithIndex(0));
                }
                Splice::Append { from, changed } => {
                    self.reshape(false);
                    ui.chat_table.beginUpdates();
                    if !changed.is_empty() {
                        let set = rows(&mut changed.into_iter());
                        ui.chat_table.noteHeightOfRowsWithIndexesChanged(&set);
                        ui.chat_table.reloadDataForRowIndexes_columnIndexes(&set, &NSIndexSet::indexSetWithIndex(0));
                    }
                    ui.chat_table.insertRowsAtIndexes_withAnimation(&rows(&mut (from..lines.len())), NSTableViewAnimationOptions::empty());
                    ui.chat_table.endUpdates();
                }
                Splice::Prepend { removed, added } => {
                    let before = total(&self.ivars().shapes.borrow());
                    let clip = ui.chat_scroll.contentView();
                    let at = clip.bounds().origin;
                    self.reshape(false);
                    let after = total(&self.ivars().shapes.borrow());
                    ui.chat_table.beginUpdates();
                    if removed > 0 {
                        ui.chat_table.removeRowsAtIndexes_withAnimation(&rows(&mut (0..removed)), NSTableViewAnimationOptions::empty());
                    }
                    ui.chat_table.insertRowsAtIndexes_withAnimation(&rows(&mut (0..added)), NSTableViewAnimationOptions::empty());
                    ui.chat_table.noteHeightOfRowsWithIndexesChanged(&rows(&mut (0..lines.len())));
                    ui.chat_table.endUpdates();
                    clip.scrollToPoint(NSPoint::new(at.x, at.y + (after - before)));
                    ui.chat_scroll.reflectScrolledClipView(&clip);
                }
            }
            if follow {
                self.follow_to_end();
            }
            if moved {
                self.ask_read();
            }
            self.ask_older_if_near_top();
        }
        *self.ivars().shown.borrow_mut() = view.selected;
    }

    fn refresh_header(&self, ui: &Ui, view: &View) {
        ui.head_name.setStringValue(&NSString::from_str(&view.title));
        ui.head_avatar.set(&view.color, &view.body, &view.title);
        ui.head_pill.setHidden(view.title.is_empty());
        let status = if !self.ivars().connected_home {
            NO_HOME_WORDS
        } else if view.connection == Connection::Connected {
            ""
        } else {
            view.status
        };
        ui.head_status.setStringValue(&NSString::from_str(status));
        ui.head_status.setHidden(status.is_empty());
        let work = laterdog_core::work::line(view.work.as_ref(), now_ms(), &|until, now| reset_time(ui, until, now));
        ui.head_work.setStringValue(&NSString::from_str(work.as_deref().unwrap_or_default()));
        ui.head_work.setHidden(work.is_none() || view.title.is_empty());
        ui.head_work.setAccessibilityRole(Some(unsafe { objc2_app_kit::NSAccessibilityStaticTextRole }));
        let placeholder = if view.title.is_empty() { "Message".to_owned() } else { format!("Message {}", view.title) };
        ui.placeholder.setStringValue(&NSString::from_str(&placeholder));
        ui.input.setAccessibilityLabel(Some(&NSString::from_str(&placeholder)));
        let model = view.model.as_deref().map(model_name).unwrap_or_default();
        ui.model_label.setStringValue(&NSString::from_str(&model));
        for part in [&*ui.model_label as &NSView, &ui.model_ring, &ui.model_mark, &ui.model_chevrons] {
            part.setHidden(model.is_empty());
        }
        self.layout();
    }

    fn at_bottom(&self, ui: &Ui) -> bool {
        let visible = ui.chat_scroll.contentView().documentVisibleRect();
        let height = ui.chat_table.frame().size.height;
        visible.origin.y + visible.size.height >= height - 24.0
    }

    fn follow_to_end(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let rows = ui.chat_table.numberOfRows();
        if rows > 0 {
            ui.chat_table.scrollRowToVisible(rows - 1);
        }
    }

    fn select_wanted(&self) {
        let wanted = self.ivars().options.select.clone();
        let target = wanted.and_then(|wanted| self.ivars().session.borrow().store.find_dog(&wanted));
        if let Some(target) = target {
            if self.ivars().session.borrow_mut().store.select(&target) {
                self.refresh(Changes { sidebar: true, transcript: true });
            }
        }
    }

    fn capture_soon(&self) {
        DispatchQueue::main().exec_async(|| with_controller(|controller| controller.capture()));
    }

    fn scroll_step(&self, steps: u32) {
        let Some(ui) = self.ivars().ui.get() else { return };
        let clip = ui.chat_scroll.contentView();
        let at = clip.bounds().origin;
        let more = {
            let session = self.ivars().session.borrow();
            session.store.selected_thread().is_some_and(|thread| session.store.has_older(thread))
        };
        if at.y > 1.0 || more {
            clip.scrollToPoint(NSPoint::new(at.x, (at.y - 400.0).max(0.0)));
            ui.chat_scroll.reflectScrolledClipView(&clip);
            ui.root.displayIfNeeded();
            on_main_after(Duration::from_millis(16), move |controller| controller.scroll_step(steps + 1));
            return;
        }
        let rows = ui.chat_table.numberOfRows();
        let messages = {
            let session = self.ivars().session.borrow();
            session.store.selected_thread().map_or(0, |thread| session.store.thread(thread).len())
        };
        for row in 0..rows {
            ui.chat_table.scrollRowToVisible(row);
            ui.root.displayIfNeeded();
        }
        let report = serde_json::json!({ "scrolled": true, "steps": steps, "rows": rows, "messages": messages, "olderPages": self.ivars().older_pages.get(), "pid": std::process::id() });
        let mut out = std::io::stdout().lock();
        writeln!(out, "{report}").ok();
        out.flush().ok();
    }

    fn capture(&self) {
        let Some(ui) = self.ivars().ui.get() else { return };
        if self.ivars().options.scroll_through {
            ui.window.orderFrontRegardless();
            self.scroll_step(0);
            return;
        }
        let frame = unsafe { ui.root.superview() }.unwrap_or_else(|| Retained::into_super(ui.root.clone()));
        self.follow_to_end();
        for scroll in [&ui.dog_scroll, &ui.chat_scroll] {
            if let Some(scroller) = scroll.verticalScroller() {
                scroller.setHidden(true);
            }
        }
        frame.layoutSubtreeIfNeeded();
        frame.displayIfNeeded();
        let first_page_ms = self.ivars().options.started.elapsed().as_millis() as u64;
        laterdog_mac::timing::mark("first page drawn");
        let mut report = serde_json::json!({ "firstPageMs": first_page_ms });
        if let Some(path) = &self.ivars().options.snapshot {
            let written = snapshot(&frame, path);
            let bounds = frame.bounds();
            report["snapshot"] = serde_json::json!({ "path": path, "written": written, "width": bounds.size.width, "height": bounds.size.height });
        }
        if self.ivars().options.tree {
            report["tree"] = describe(&frame, &frame);
        }
        let mut out = std::io::stdout().lock();
        writeln!(out, "{}", serde_json::to_string_pretty(&report).unwrap_or_default()).ok();
        out.flush().ok();
        std::process::exit(0);
    }

    fn check_dump(&self) {
        if !self.ivars().options.dump {
            return;
        }
        let (ready, composed, reply) = {
            let dump = self.ivars().dump.borrow();
            (dump.page && dump.framed, dump.composed.clone(), dump.reply_by_stream)
        };
        if let Some(send_id) = &composed {
            let held = self.ivars().session.borrow().store.send_state(send_id) == Some(SendState::Held);
            if held && self.ivars().options.thread.is_some() {
                self.finish_dump(0);
                return;
            }
        }
        if !ready {
            return;
        }
        let wanted = self.ivars().options.history;
        if wanted > 0 && self.ivars().older_pages.get() < wanted {
            let thread = self.ivars().session.borrow().store.selected_thread().map(str::to_owned);
            let more = thread.as_deref().is_some_and(|thread| self.ivars().session.borrow().store.has_older(thread));
            if more {
                if self.ivars().session.borrow_mut().ask_older() {
                    self.ivars().dump.borrow_mut().older_asked += 1;
                }
                return;
            }
        }
        let Some(request) = &self.ivars().options.send else {
            if self.ivars().session.borrow().store.unsettled_sends() == 0 {
                self.finish_dump(0);
            }
            return;
        };
        match composed {
            None => {
                let target = match &request.to {
                    Some(wanted) => self.ivars().session.borrow().store.find_dog(wanted),
                    None => self.ivars().session.borrow().store.selected().map(str::to_owned),
                };
                let Some(target) = target else {
                    eprintln!("No dog matches {:?} on this home.", request.to.as_deref().unwrap_or_default());
                    self.finish_dump(2);
                    return;
                };
                if self.ivars().session.borrow_mut().store.select(&target) {
                    self.refresh(Changes { sidebar: true, transcript: true });
                }
                if !self.compose(&request.text) {
                    eprintln!("The message could not be queued.");
                    self.finish_dump(2);
                }
            }
            Some(send_id) => {
                let sent = self.ivars().session.borrow().store.send_state(&send_id) == Some(SendState::Sent);
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
        let session = self.ivars().session.borrow();
        let store = &session.store;
        let dump = self.ivars().dump.borrow();
        let mut value = serde_json::to_value(store.view()).unwrap_or_default();
        if let Some(object) = value.as_object_mut() {
            object.insert("stream".into(), serde_json::json!({ "frames": dump.frames, "replyByStream": dump.reply_by_stream }));
            let thread = store.selected_thread().unwrap_or_default();
            object.insert("history".into(), serde_json::json!({ "pagesLoaded": self.ivars().older_pages.get(), "hasOlder": store.has_older(thread), "messages": store.thread(thread).len() }));
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

fn scroller(mtm: MainThreadMarker, table: &NSTableView) -> Retained<NSScrollView> {
    let scroll = NSScrollView::initWithFrame(NSScrollView::alloc(mtm), rect(0.0, 0.0, 100.0, 100.0));
    scroll.setHasVerticalScroller(true);
    scroll.setAutohidesScrollers(true);
    scroll.setScrollerStyle(objc2_app_kit::NSScrollerStyle::Overlay);
    scroll.setDrawsBackground(false);
    scroll.setDocumentView(Some(table));
    scroll
}

fn place_traffic_lights(window: &NSWindow) {
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else { return };
    let Some(bar) = (unsafe { close.superview() }) else { return };
    let Some(container) = (unsafe { bar.superview() }) else { return };
    let window_height = window.frame().size.height;
    let mut frame = container.frame();
    frame.size.height = theme::TOP_BAR_HEIGHT;
    frame.origin.y = window_height - theme::TOP_BAR_HEIGHT;
    container.setFrame(frame);
    let flipped = bar.isFlipped();
    for (index, kind) in [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton].into_iter().enumerate() {
        let Some(button) = window.standardWindowButton(kind) else { continue };
        let size = button.frame().size;
        let bar_height = bar.frame().size.height;
        let top = theme::TRAFFIC_LIGHT_CENTER_Y - size.height / 2.0;
        let y = if flipped { top } else { bar_height - top - size.height };
        button.setFrameOrigin(objc2_foundation::NSPoint::new(theme::TRAFFIC_LIGHT_X - 2.0 + index as f64 * 20.0, y));
    }
}

fn reset_time(ui: &Ui, until: u64, now: u64) -> String {
    let same_day = NSCalendar::currentCalendar().isDate_inSameDayAsDate(&date(until), &date(now));
    let formatter = if same_day { &ui.times } else { &ui.weekday_times };
    formatter.stringFromDate(&date(until)).to_string()
}

pub fn toggle_wrap(key: &str) {
    with_controller(|controller| controller.toggle_wrap(key));
}

fn new_dog_cell(mtm: MainThreadMarker, theme: &Theme) -> Retained<DogCell> {
    let selection = Fill::new(mtm, None, theme::ROW_RADIUS);
    let avatar = Avatar::new(mtm);
    let name = label(mtm, "", &font(14.0, Weight::Semibold), &theme.ink);
    let time = label(mtm, "", &font(12.0, Weight::Regular), &theme.ink_secondary);
    time.setAlignment(NSTextAlignment::Right);
    let preview = label(mtm, "", &font(11.0, Weight::Regular), &theme.ink_secondary);
    let dot = Fill::new(mtm, Some(&theme.unread), ROUND);
    let this = DogCell::alloc(mtm).set_ivars(OnceCell::new());
    let cell: Retained<DogCell> = unsafe { msg_send![super(this), initWithFrame: rect(0.0, 0.0, 300.0, 56.0)] };
    for view in [&*selection as &NSView, &avatar, &name, &time, &preview, &dot] {
        cell.addSubview(view);
    }
    cell.setIdentifier(Some(&NSString::from_str(DOG_CELL)));
    cell.ivars().set(DogParts { selection, avatar, name, time, preview, dot }).ok();
    cell
}

fn configure_dog(cell: &DogCell, dog: &SidebarRow, width: f64, ui: &Ui) {
    let Some(parts) = cell.ivars().get() else { return };
    let theme = &ui.theme;
    let inset = theme::SIDEBAR_LIST_INSET;
    let row_top = theme::ROW_GAP / 2.0;
    let row_width = width - inset * 2.0;
    parts.selection.setFrame(rect(inset, row_top, row_width, theme::ROW_HEIGHT));
    parts.selection.set_fill(dog.selected.then_some(&*theme.selected_row));
    let avatar_x = inset + theme::ROW_PAD_LEFT;
    parts.avatar.setFrame(rect(avatar_x, row_top + (theme::ROW_HEIGHT - theme::ROW_AVATAR) / 2.0, theme::ROW_AVATAR, theme::ROW_AVATAR));
    parts.avatar.set(&dog.color, &dog.body, &dog.name);
    let text_x = avatar_x + theme::ROW_AVATAR + theme::ROW_GAP_X;
    let text_right = inset + row_width - theme::ROW_PAD_RIGHT;
    let time_words = match (dog.selected, dog.last_at) {
        (true, Some(at)) => ui.times.stringFromDate(&date(at)).to_string(),
        _ => String::new(),
    };
    parts.time.setStringValue(&NSString::from_str(&time_words));
    let time_width = if time_words.is_empty() { 0.0 } else { parts.time.attributedStringValue().size().width.ceil() + 4.0 };
    let name_top = row_top + 8.0;
    parts.time.setFrame(rect(text_right - time_width, name_top + 3.0, time_width, 16.0));
    parts.name.setStringValue(&NSString::from_str(&dog.name));
    parts.name.setFrame(rect(text_x - 2.0, name_top + 1.0, (text_right - time_width - 8.0 - text_x).max(10.0), 19.0));
    let dot_shown = dog.unread || dog.waiting;
    parts.dot.setHidden(!dot_shown);
    parts.dot.set_fill(Some(if dog.waiting { &*theme.waiting } else { &*theme.unread }));
    let preview_top = name_top + 21.0;
    parts.dot.setFrame(rect(text_right - theme::DOT, preview_top + (16.5 - theme::DOT) / 2.0, theme::DOT, theme::DOT));
    let work = if dog.waiting { None } else { laterdog_core::work::sidebar_line(dog.work.as_ref(), now_ms(), &|until, now| reset_time(ui, until, now)) };
    let preview_words = match &work {
        Some(line) => line.clone(),
        None if dog.working => "\u{2022}\u{2022}\u{2022}".to_owned(),
        None => dog.preview.clone(),
    };
    parts.preview.setStringValue(&NSString::from_str(&preview_words));
    let preview_right = if dot_shown { text_right - theme::DOT - 8.0 } else { text_right };
    parts.preview.setFrame(rect(text_x - 2.0, preview_top + 1.0, (preview_right - text_x).max(10.0), 15.0));
    let mut spoken = dog.name.clone();
    if let Some(line) = &work {
        spoken.push_str(&format!(" \u{b7} {line}"));
    } else if dog.working {
        spoken.push_str(" \u{b7} Working");
    }
    if dog.waiting {
        spoken.push_str(" \u{b7} Needs you");
    }
    if dog.unread {
        spoken.push_str(" \u{b7} Unread");
    }
    cell.setAccessibilityLabel(Some(&NSString::from_str(&spoken)));
}

fn new_chat_cell(mtm: MainThreadMarker, theme: &Theme, controller: Option<&AnyObject>) -> Retained<ChatCell> {
    let day = label(mtm, "", &font(13.0, Weight::Regular), &theme.ink_secondary);
    day.setAlignment(NSTextAlignment::Center);
    let bubble = Fill::new(mtm, Some(&theme.card), theme::BUBBLE_RADIUS);
    let status = label(mtm, "", &font(11.0, Weight::Regular), &theme.ink_tertiary);
    status.setAlignment(NSTextAlignment::Right);
    let work = label(mtm, "View work", &font(12.0, Weight::Regular), &theme.ink_secondary);
    let chevron = icon(mtm, "chevron.right", 9.0, unsafe { NSFontWeightMedium }, &theme.ink_secondary);
    let again = unsafe { NSButton::buttonWithTitle_target_action(&NSString::from_str("Send again"), controller, Some(sel!(sendAgain:)), mtm) };
    again.setBordered(false);
    again.setFont(Some(&font(11.0, Weight::Medium)));
    again.setContentTintColor(Some(&theme.ink));
    let this = ChatCell::alloc(mtm).set_ivars(OnceCell::new());
    let cell: Retained<ChatCell> = unsafe { msg_send![super(this), initWithFrame: rect(0.0, 0.0, 600.0, 40.0)] };
    for view in [&*day as &NSView, &bubble, &status, &work, &chevron, &again] {
        cell.addSubview(view);
    }
    let quiet_font = font(13.0, Weight::Regular);
    let quiet = QuietParts {
        label: label(mtm, "", &quiet_font, &theme.ink_secondary),
        face: Avatar::new(mtm),
        name: label(mtm, "", &quiet_font, &theme.ink_secondary),
        gist: label(mtm, "", &quiet_font, &theme.ink_tertiary),
        state: label(mtm, "", &quiet_font, &theme.ink_tertiary),
        chevron: icon(mtm, "chevron.right", 9.0, unsafe { NSFontWeightMedium }, &theme.ink_tertiary),
        open: unsafe { NSButton::buttonWithTitle_target_action(&NSString::from_str(""), controller, Some(sel!(toggleExchange:)), mtm) },
        toggle: unsafe { NSButton::buttonWithTitle_target_action(&NSString::from_str(""), controller, Some(sel!(toggleExchange:)), mtm) },
        details: Fill::new(mtm, Some(&theme.panel_50), 18.0),
        text: rich::text_part(mtm, theme, None),
    };
    quiet.details.set_stroke(Some(&theme.hairline_50), 1.0);
    quiet.details.addSubview(&quiet.text.view);
    for button in [&quiet.open, &quiet.toggle] {
        button.setBordered(false);
        button.setTransparent(true);
    }
    quiet.toggle.setAccessibilityLabel(Some(&NSString::from_str(laterdog_core::words::EXCHANGE_DETAILS)));
    quiet.toggle.setToolTip(Some(&NSString::from_str(laterdog_core::words::EXCHANGE_DETAILS)));
    for view in [&*quiet.label as &NSView, &quiet.face, &quiet.name, &quiet.gist, &quiet.state, &quiet.chevron, &quiet.open, &quiet.toggle, &quiet.details] {
        view.setHidden(true);
        cell.addSubview(view);
    }
    cell.setIdentifier(Some(&NSString::from_str(CHAT_CELL)));
    cell.ivars().set(ChatParts { quiet, again, day, bubble, texts: RefCell::new(Vec::new()), codes: RefCell::new(Vec::new()), rules: RefCell::new(Vec::new()), status, work, chevron }).ok();
    cell
}

#[allow(clippy::too_many_arguments)]
fn configure_line(cell: &ChatCell, line: &Line, shape: &Shape, gap: f64, width: f64, color: &str, ui: &Ui, controller: &Controller) {
    let Some(parts) = cell.ivars().get() else { return };
    let theme = &ui.theme;
    let (day, bubble, work) = (matches!(line, Line::Day(_)), matches!(line, Line::Bubble(_)), matches!(line, Line::Work(_)));
    let quiet = &parts.quiet;
    let exchange = matches!(line, Line::Exchange(_));
    for view in [&*quiet.label as &NSView, &quiet.face, &quiet.name, &quiet.gist, &quiet.state, &quiet.chevron, &quiet.open, &quiet.toggle] {
        view.setHidden(!exchange);
    }
    quiet.details.setHidden(true);
    parts.day.setHidden(!day);
    parts.bubble.setHidden(!bubble);
    parts.status.setHidden(true);
    parts.again.setHidden(true);
    parts.work.setHidden(!work);
    parts.chevron.setHidden(!work);
    match line {
        Line::Day(at) => {
            let when = date(*at);
            let words = format!("{} {}", ui.days.stringFromDate(&when), ui.times.stringFromDate(&when));
            parts.day.setStringValue(&NSString::from_str(&words));
            parts.day.setFrame(rect(0.0, gap + theme::DAY_PAD_Y, width, theme::DAY_LINE));
        }
        Line::Exchange(row) => {
            if let Some(line) = &row.exchange {
                place_exchange(cell, quiet, row, line, shape, gap, width, theme);
            }
        }
        Line::Work(_) => {
            parts.work.setFrame(rect(-2.0, gap + 12.0, 70.0, 16.0));
            let words = parts.work.attributedStringValue().size().width.ceil();
            parts.chevron.setFrame(rect(words + 6.0, gap + 14.0, 12.0, 12.0));
            cell.setAccessibilityLabel(Some(&NSString::from_str("View work")));
        }
        Line::Bubble(row) => {
            let Some(layout) = shape.layout.as_deref() else { return };
            let bubble_width = layout.width + theme::BUBBLE_PAD_X * 2.0;
            let bubble_height = layout.height + theme::BUBBLE_PAD_Y * 2.0;
            let x = if row.mine { width - bubble_width } else { 0.0 };
            parts.bubble.setFrame(rect(x, gap, bubble_width, bubble_height));
            parts.bubble.set_fill(Some(&*if row.mine { theme.tint(color) } else { theme.card.clone() }));
            place_pieces(parts, layout, row, theme, controller);
            if let Some(words) = row.status.filter(|words| *words != SendState::Sent.words()) {
                parts.status.setHidden(false);
                parts.status.setStringValue(&NSString::from_str(words));
                let refused = words == SendState::NotSent.words();
                let again_width = if refused { 74.0 } else { 0.0 };
                parts.status.setFrame(rect(0.0, gap + bubble_height + 2.0, width - again_width, 14.0));
                if let (true, Some(send_id)) = (refused, row.send_id.as_deref()) {
                    parts.again.setHidden(false);
                    parts.again.setIdentifier(Some(&NSString::from_str(send_id)));
                    parts.again.setFrame(rect(width - again_width + 4.0, gap + bubble_height, again_width - 4.0, 18.0));
                }
            }
            let speaker = if row.mine { "You" } else { row.who.as_str() };
            cell.setAccessibilityLabel(Some(&NSString::from_str(&format!("{speaker}: {}", row.text))));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn place_exchange(cell: &ChatCell, quiet: &QuietParts, row: &TranscriptRow, line: &laterdog_core::exchange::ExchangeLine, shape: &Shape, gap: f64, width: f64, theme: &Theme) {
    let measure = |field: &NSTextField, words: &str| -> f64 {
        field.setStringValue(&NSString::from_str(words));
        if words.is_empty() { 0.0 } else { field.attributedStringValue().size().width.ceil() }
    };
    let label_width = measure(&quiet.label, line.label);
    let mut name_width = measure(&quiet.name, &line.name);
    let mut gist_width = measure(&quiet.gist, &line.gist.as_ref().map(|gist| format!("\u{b7} {gist}")).unwrap_or_default()).min(320.0);
    let state_width = measure(&quiet.state, &format!("\u{b7} {}", line.state));
    quiet.state.setTextColor(Some(if line.needs_you() { &theme.ink } else { &theme.ink_tertiary }));
    let face = 14.0;
    let gaps = |gist: f64| 6.0 * if gist > 0.0 { 4.0 } else { 3.0 };
    let toggle = 4.0 + 16.0;
    let fixed = 6.0 + label_width + face + state_width + 6.0 + toggle;
    let room = (width - fixed - gaps(gist_width)).max(0.0);
    if name_width + gist_width > room {
        gist_width = (room - name_width.min(room * 0.5)).max(0.0);
        name_width = name_width.min(room - gist_width);
    }
    let total = fixed + gaps(gist_width) + name_width + gist_width;
    let left = ((width - total) / 2.0).max(0.0).round();
    let top = gap + 2.0;
    let mut x = left + 6.0;
    let text_top = top + (18.0 - 16.0) / 2.0;
    quiet.label.setFrame(rect(x - 2.0, text_top, label_width + 4.0, 16.0));
    x += label_width + 6.0;
    quiet.face.setFrame(rect(x, top + 2.0, face, face));
    quiet.face.set(&line.color, &line.body, &line.name);
    x += face + 6.0;
    quiet.name.setFrame(rect(x - 2.0, text_top, name_width + 4.0, 16.0));
    x += name_width + 6.0;
    quiet.gist.setHidden(gist_width <= 0.0);
    if gist_width > 0.0 {
        quiet.gist.setFrame(rect(x - 2.0, text_top, gist_width + 4.0, 16.0));
        x += gist_width + 6.0;
    }
    quiet.state.setFrame(rect(x - 2.0, text_top, state_width + 4.0, 16.0));
    x += state_width + 6.0;
    quiet.open.setFrame(rect(left, gap, x - left, theme::QUIET_LINE));
    quiet.toggle.setFrame(rect(x + 4.0 - 6.0, gap + 3.0, 16.0, 16.0));
    quiet.chevron.setFrame(rect(x + 4.0 - 6.0, gap + 3.0, 16.0, 16.0));
    let open = shape.details.is_some();
    let symbol = if open { "chevron.down" } else { "chevron.right" };
    if let Some(image) = crate::widgets::symbol(symbol, 9.0, unsafe { NSFontWeightMedium }) {
        quiet.chevron.setImage(Some(&image));
    }
    for button in [&quiet.open, &quiet.toggle] {
        button.setIdentifier(Some(&NSString::from_str(&row.id)));
    }
    let spoken = if open { format!("{} \u{b7} {}", line.spoken(), laterdog_core::words::EXCHANGE_DETAILS) } else { line.spoken() };
    quiet.open.setAccessibilityLabel(Some(&NSString::from_str(&spoken)));
    quiet.open.setToolTip(Some(&NSString::from_str(&line.spoken())));
    if let Some((string, box_width, box_height)) = &shape.details {
        let box_x = ((width - box_width) / 2.0).round();
        quiet.details.setFrame(rect(box_x, gap + theme::QUIET_LINE + 6.0, *box_width, *box_height));
        quiet.details.setHidden(false);
        quiet.text.show(string, rect(9.0, 9.0, box_width - 18.0, box_height - 18.0), false, theme);
    }
    cell.setAccessibilityLabel(Some(&NSString::from_str(&line.spoken())));
}

fn place_pieces(parts: &ChatParts, layout: &rich::Layout, row: &TranscriptRow, theme: &Theme, controller: &Controller) {
    let mtm = controller.mtm();
    let mut texts = parts.texts.borrow_mut();
    let mut codes = parts.codes.borrow_mut();
    let mut rules = parts.rules.borrow_mut();
    let (mut text_at, mut code_at, mut rule_at) = (0, 0, 0);
    let origin = |placed: &rich::Placed, height: f64| rect(theme::BUBBLE_PAD_X + placed.x, theme::BUBBLE_PAD_Y + placed.y, placed.width, height);
    for placed in &layout.pieces {
        match &placed.piece {
            rich::Piece::Text { string, .. } => {
                if texts.len() <= text_at {
                    let part = rich::text_part(mtm, theme, Some(ProtocolObject::from_ref(controller)));
                    parts.bubble.addSubview(&part.view);
                    texts.push(part);
                }
                texts[text_at].show(string, origin(placed, placed.height), row.mine, theme);
                text_at += 1;
            }
            rich::Piece::Code { .. } | rich::Piece::Table { .. } => {
                if codes.len() <= code_at {
                    let code = rich::CodeBox::new(mtm, theme);
                    parts.bubble.addSubview(&code);
                    codes.push(code);
                }
                let index = if let rich::Piece::Code { index, .. } = &placed.piece { *index } else { usize::MAX };
                let code = &codes[code_at];
                code.show(placed, &format!("{}#{index}", row.id), theme);
                code.setFrame(origin(placed, placed.height));
                code.setHidden(false);
                code_at += 1;
            }
            rich::Piece::Rule => {
                if rules.len() <= rule_at {
                    let line = rich::rule(mtm, theme);
                    parts.bubble.addSubview(&line);
                    rules.push(line);
                }
                rules[rule_at].setFrame(origin(placed, 1.0));
                rules[rule_at].setHidden(false);
                rule_at += 1;
            }
        }
    }
    for part in texts.iter().skip(text_at) {
        part.view.setHidden(true);
    }
    for code in codes.iter().skip(code_at) {
        code.setHidden(true);
    }
    for line in rules.iter().skip(rule_at) {
        line.setHidden(true);
    }
}

fn snapshot(view: &NSView, path: &str) -> bool {
    let bounds = view.bounds();
    let Some(bitmap) = view.bitmapImageRepForCachingDisplayInRect(bounds) else { return false };
    view.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);
    let Some(png) = (unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }) else {
        return false;
    };
    png.writeToFile_atomically(&NSString::from_str(path), true)
}

fn described(object: &AnyObject) -> String {
    if let Some(text) = object.downcast_ref::<NSString>() {
        return text.to_string();
    }
    let description: Retained<NSString> = unsafe { msg_send![object, description] };
    description.to_string()
}

fn clipped(text: String) -> String {
    if text.chars().count() <= 240 {
        return text;
    }
    let mut short: String = text.chars().take(240).collect();
    short.push('\u{2026}');
    short
}

fn describe(view: &NSView, root: &NSView) -> serde_json::Value {
    let frame = view.convertRect_toView(view.bounds(), Some(root));
    let mut node = serde_json::json!({
        "class": view.class().name().to_string_lossy(),
        "frame": [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height],
    });
    if let Some(role) = view.accessibilityRole() {
        node["role"] = serde_json::Value::String(role.to_string());
    }
    if let Some(label) = view.accessibilityLabel().filter(|label| label.length() > 0) {
        node["label"] = serde_json::Value::String(label.to_string());
    }
    if let Some(value) = view.accessibilityValue() {
        node["value"] = serde_json::Value::String(clipped(described(&value)));
    }
    if view.isHidden() {
        node["hidden"] = serde_json::Value::Bool(true);
    }
    let children: Vec<serde_json::Value> = view.subviews().iter().map(|child| describe(&child, root)).collect();
    if !children.is_empty() {
        node["children"] = serde_json::Value::Array(children);
    }
    node
}

pub fn set_appearance(app: &NSApplication, name: &str) {
    let named = match name {
        "dark" => unsafe { NSAppearanceNameDarkAqua },
        _ => unsafe { NSAppearanceNameAqua },
    };
    app.setAppearance(NSAppearance::appearanceNamed(named).as_deref());
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
