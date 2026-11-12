use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSFont, NSScrollView, NSSplitView, NSStackView,
    NSTextField, NSTextView, NSUserInterfaceLayoutOrientation, NSView, NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

fn sidebar(mtm: MainThreadMarker, dogs: usize) -> Retained<NSScrollView> {
    let rows = NSStackView::new(mtm);
    rows.setOrientation(NSUserInterfaceLayoutOrientation::Vertical);
    rows.setSpacing(6.0);
    for index in 0..dogs {
        let label = NSTextField::labelWithString(&NSString::from_str(&format!("Dog {}", index + 1)), mtm);
        rows.addArrangedSubview(&label);
    }
    let scroll = NSScrollView::initWithFrame(NSScrollView::alloc(mtm), rect(0.0, 0.0, 240.0, 720.0));
    scroll.setHasVerticalScroller(true);
    scroll.setDocumentView(Some(&rows));
    scroll
}

fn transcript(mtm: MainThreadMarker, messages: usize) -> Retained<NSScrollView> {
    let scroll = NSTextView::scrollableTextView(mtm);
    let mut body = String::new();
    for index in 0..messages {
        let who = if index % 2 == 0 { "You" } else { "Dog" };
        body.push_str(&format!(
            "{who}\nMessage {index}: a paragraph of ordinary prose about the work in hand, long enough to wrap across the window and show how a transcript reads.\n\n"
        ));
    }
    if let Some(document) = scroll.documentView() {
        if let Ok(text) = document.downcast::<NSTextView>() {
            text.setEditable(false);
            text.setFont(Some(&NSFont::systemFontOfSize(14.0)));
            text.setString(&NSString::from_str(&body));
        }
    }
    scroll
}

fn main() {
    let mtm = MainThreadMarker::new().expect("the app starts on the main thread");
    let dogs = std::env::var("LATERDOG_SPIKE_DOGS").ok().and_then(|v| v.parse().ok()).unwrap_or(80);
    let messages = std::env::var("LATERDOG_SPIKE_MESSAGES").ok().and_then(|v| v.parse().ok()).unwrap_or(240);

    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);

    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable;
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect(0.0, 0.0, 1180.0, 760.0),
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("later.dog"));

    let split = NSSplitView::initWithFrame(NSSplitView::alloc(mtm), rect(0.0, 0.0, 1180.0, 760.0));
    split.setVertical(true);
    split.addArrangedSubview(&sidebar(mtm, dogs));
    split.addArrangedSubview(&transcript(mtm, messages));
    let content: &NSView = &split;
    window.setContentView(Some(content));
    window.center();
    window.makeKeyAndOrderFront(None);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    app.run();
}
