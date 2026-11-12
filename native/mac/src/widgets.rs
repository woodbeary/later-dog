use std::cell::{Cell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBezierPath, NSButton, NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSImage,
    NSImageScaling, NSImageSymbolConfiguration, NSImageView, NSLineBreakMode, NSParagraphStyleAttributeName,
    NSMutableParagraphStyle, NSTextAlignment, NSTextField, NSView, NSFontWeight, NSAttributedStringNSStringDrawing,
    NSBaselineOffsetAttributeName,
};
use objc2_foundation::{NSAttributedString, NSDictionary, NSNumber, NSPoint, NSRect, NSSize, NSString};

pub fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    pub struct Flipped;

    impl Flipped {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }
    }
);

impl Flipped {
    pub fn new(mtm: MainThreadMarker) -> Retained<Self> {
        unsafe { msg_send![Self::alloc(mtm), initWithFrame: rect(0.0, 0.0, 10.0, 10.0)] }
    }
}

pub struct FillIvars {
    fill: RefCell<Option<Retained<NSColor>>>,
    stroke: RefCell<Option<Retained<NSColor>>>,
    stroke_width: Cell<f64>,
    radius: Cell<f64>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = FillIvars]
    pub struct Fill;

    impl Fill {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            self.paint();
        }
    }
);

pub const ROUND: f64 = -1.0;

impl Fill {
    pub fn new(mtm: MainThreadMarker, fill: Option<&NSColor>, radius: f64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(FillIvars {
            fill: RefCell::new(fill.map(Retained::from)),
            stroke: RefCell::new(None),
            stroke_width: Cell::new(0.0),
            radius: Cell::new(radius),
        });
        unsafe { msg_send![super(this), initWithFrame: rect(0.0, 0.0, 10.0, 10.0)] }
    }

    pub fn set_fill(&self, fill: Option<&NSColor>) {
        let same = match (&*self.ivars().fill.borrow(), fill) {
            (Some(old), Some(new)) => std::ptr::eq(&**old, new),
            (None, None) => true,
            _ => false,
        };
        if !same {
            *self.ivars().fill.borrow_mut() = fill.map(Retained::from);
            self.setNeedsDisplay(true);
        }
    }

    pub fn set_stroke(&self, stroke: Option<&NSColor>, width: f64) {
        *self.ivars().stroke.borrow_mut() = stroke.map(Retained::from);
        self.ivars().stroke_width.set(width);
        self.setNeedsDisplay(true);
    }

    fn paint(&self) {
        let bounds = self.bounds();
        let radius = self.ivars().radius.get();
        let radius = if radius < 0.0 { bounds.size.width.min(bounds.size.height) / 2.0 } else { radius };
        if let Some(fill) = &*self.ivars().fill.borrow() {
            let path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(bounds, radius, radius);
            fill.setFill();
            path.fill();
        }
        let width = self.ivars().stroke_width.get();
        if let (Some(stroke), true) = (&*self.ivars().stroke.borrow(), width > 0.0) {
            let inset = rect(bounds.origin.x + width / 2.0, bounds.origin.y + width / 2.0, bounds.size.width - width, bounds.size.height - width);
            let path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(inset, (radius - width / 2.0).max(0.0), (radius - width / 2.0).max(0.0));
            path.setLineWidth(width);
            stroke.setStroke();
            path.stroke();
        }
    }
}

pub struct AvatarIvars {
    color: RefCell<Retained<NSColor>>,
    letter: RefCell<String>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = AvatarIvars]
    pub struct Avatar;

    impl Avatar {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            self.paint();
        }
    }
);

impl Avatar {
    pub fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(AvatarIvars { color: RefCell::new(NSColor::grayColor()), letter: RefCell::new(String::new()) });
        unsafe { msg_send![super(this), initWithFrame: rect(0.0, 0.0, 32.0, 32.0)] }
    }

    pub fn set(&self, color: Retained<NSColor>, name: &str) {
        let letter: String = name.chars().find(|c| c.is_alphanumeric()).map(|c| c.to_uppercase().collect()).unwrap_or_default();
        *self.ivars().color.borrow_mut() = color;
        *self.ivars().letter.borrow_mut() = letter;
        self.setNeedsDisplay(true);
    }

    fn paint(&self) {
        let bounds = self.bounds();
        self.ivars().color.borrow().setFill();
        NSBezierPath::bezierPathWithOvalInRect(bounds).fill();
        let letter = self.ivars().letter.borrow();
        if letter.is_empty() {
            return;
        }
        let size = bounds.size.width * 0.44;
        let text = attributed(&letter, &crate::theme::font(size, crate::theme::Weight::Semibold), &NSColor::whiteColor(), None);
        let measured = text.size();
        let at = NSPoint::new(bounds.origin.x + (bounds.size.width - measured.width) / 2.0, bounds.origin.y + (bounds.size.height - measured.height) / 2.0);
        text.drawAtPoint(at);
    }
}

pub fn paragraph(line_height: Option<f64>, alignment: NSTextAlignment) -> Retained<NSMutableParagraphStyle> {
    let style = NSMutableParagraphStyle::new();
    if let Some(height) = line_height {
        style.setMinimumLineHeight(height);
        style.setMaximumLineHeight(height);
    }
    style.setAlignment(alignment);
    style.setLineBreakMode(NSLineBreakMode::ByWordWrapping);
    style
}

pub fn attributed(text: &str, font: &NSFont, color: &NSColor, line: Option<(f64, f64)>) -> Retained<NSAttributedString> {
    let style = paragraph(line.map(|(height, _)| height), NSTextAlignment::Left);
    let offset = NSNumber::new_f64(line.map_or(0.0, |(_, offset)| offset));
    let keys: [&NSString; 4] = unsafe { [NSFontAttributeName, NSForegroundColorAttributeName, NSParagraphStyleAttributeName, NSBaselineOffsetAttributeName] };
    let objects: [&AnyObject; 4] = [font.as_ref(), color.as_ref(), style.as_ref(), offset.as_ref()];
    let attributes = NSDictionary::from_slices(&keys, &objects);
    unsafe { NSAttributedString::new_with_attributes(&NSString::from_str(text), &attributes) }
}

pub fn label(mtm: MainThreadMarker, text: &str, font: &NSFont, color: &NSColor) -> Retained<NSTextField> {
    let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    field.setFont(Some(font));
    field.setTextColor(Some(color));
    field.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
    field.setDrawsBackground(false);
    field
}

pub fn symbol(name: &str, size: f64, weight: NSFontWeight) -> Option<Retained<NSImage>> {
    let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(&NSString::from_str(name), None)?;
    let configuration = NSImageSymbolConfiguration::configurationWithPointSize_weight(size, weight);
    image.imageWithSymbolConfiguration(&configuration)
}

pub fn icon(mtm: MainThreadMarker, name: &str, size: f64, weight: NSFontWeight, tint: &NSColor) -> Retained<NSImageView> {
    let view = match symbol(name, size, weight) {
        Some(image) => NSImageView::imageViewWithImage(&image, mtm),
        None => NSImageView::new(mtm),
    };
    view.setContentTintColor(Some(tint));
    view.setImageScaling(NSImageScaling::ScaleNone);
    view
}

pub fn icon_button(mtm: MainThreadMarker, name: &str, size: f64, weight: NSFontWeight, tint: &NSColor, label: &str, target: Option<&AnyObject>, action: Option<Sel>) -> Retained<NSButton> {
    let image = symbol(name, size, weight).unwrap_or_else(|| NSImage::new());
    let button = unsafe { NSButton::buttonWithImage_target_action(&image, target, action, mtm) };
    button.setBordered(false);
    button.setContentTintColor(Some(tint));
    button.setImageScaling(NSImageScaling::ScaleNone);
    objc2_app_kit::NSAccessibility::setAccessibilityLabel(&*button, Some(&NSString::from_str(label)));
    button
}
