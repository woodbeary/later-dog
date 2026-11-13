use std::cell::{Cell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Sel};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBezierPath, NSButton, NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSImage,
    NSImageScaling, NSImageSymbolConfiguration, NSImageView, NSLineBreakMode, NSParagraphStyleAttributeName,
    NSMutableParagraphStyle, NSTextAlignment, NSTextField, NSView, NSFontWeight, NSAttributedStringNSStringDrawing,
    NSBaselineOffsetAttributeName,
};
use laterdog_core::mascot;
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
    color: Cell<u32>,
    body: RefCell<String>,
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
        let this = Self::alloc(mtm).set_ivars(AvatarIvars {
            color: Cell::new(mascot::dog_color(mascot::DEFAULT_COLOR)),
            body: RefCell::new(mascot::DEFAULT_BODY.to_owned()),
            letter: RefCell::new(String::new()),
        });
        unsafe { msg_send![super(this), initWithFrame: rect(0.0, 0.0, 32.0, 32.0)] }
    }

    pub fn set(&self, color: &str, body: &str, name: &str) {
        let letter: String = name.chars().find(|c| c.is_alphanumeric()).map(|c| c.to_uppercase().collect()).unwrap_or_default();
        let hex = mascot::dog_color(color);
        let changed = self.ivars().color.get() != hex || *self.ivars().body.borrow() != body || *self.ivars().letter.borrow() != letter;
        if changed {
            self.ivars().color.set(hex);
            *self.ivars().body.borrow_mut() = body.to_owned();
            *self.ivars().letter.borrow_mut() = letter;
            self.setNeedsDisplay(true);
        }
    }

    fn paint(&self) {
        let bounds = self.bounds();
        let color = self.ivars().color.get();
        let body = self.ivars().body.borrow().clone();
        match mascot::breed(Some(&body)) {
            Some(breed) => face::draw(breed, color, bounds),
            None => self.letter_circle(bounds, color),
        }
    }

    fn letter_circle(&self, bounds: NSRect, color: u32) {
        crate::theme::srgb(color, 1.0).setFill();
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

mod face {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use laterdog_core::mascot::{self, Breed, Shape, Tone};
    use laterdog_core::path::{parse, Segment};
    use objc2::rc::Retained;
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSBezierPath, NSColor, NSGradient, NSGradientDrawingOptions, NSGraphicsContext, NSLineCapStyle, NSLineJoinStyle};
    use objc2_foundation::{NSArray, NSPoint, NSRect};

    use crate::theme::srgb;

    thread_local! {
        static PARSED: RefCell<HashMap<String, Vec<Segment>>> = RefCell::new(HashMap::new());
    }

    struct Frame {
        origin: NSPoint,
        scale: f64,
    }

    impl Frame {
        fn at(&self, x: f64, y: f64, mirror: bool) -> NSPoint {
            let x = if mirror { 100.0 - x } else { x };
            NSPoint::new(self.origin.x + x * self.scale, self.origin.y + y * self.scale)
        }
    }

    fn path(frame: &Frame, data: &str, mirror: bool) -> Retained<NSBezierPath> {
        let bezier = NSBezierPath::new();
        PARSED.with(|cache| {
            let mut cache = cache.borrow_mut();
            let segments = cache.entry(data.to_owned()).or_insert_with(|| parse(data).unwrap_or_default());
            for segment in segments.iter() {
                match *segment {
                    Segment::Move(point) => bezier.moveToPoint(frame.at(point.x, point.y, mirror)),
                    Segment::Line(point) => bezier.lineToPoint(frame.at(point.x, point.y, mirror)),
                    Segment::Cubic(first, second, end) => bezier.curveToPoint_controlPoint1_controlPoint2(
                        frame.at(end.x, end.y, mirror),
                        frame.at(first.x, first.y, mirror),
                        frame.at(second.x, second.y, mirror),
                    ),
                    Segment::Close => bezier.closePath(),
                }
            }
        });
        bezier
    }

    fn fill(frame: &Frame, shapes: &[Shape], color: u32, mirror: bool) {
        for shape in shapes {
            srgb(mascot::tone(color, shape.tone), 1.0).setFill();
            path(frame, shape.d, mirror).fill();
        }
    }

    fn oval(frame: &Frame, cx: f64, cy: f64, rx: f64, ry: f64) -> Retained<NSBezierPath> {
        let low = frame.at(cx - rx, cy - ry, false);
        NSBezierPath::bezierPathWithOvalInRect(NSRect::new(low, objc2_foundation::NSSize::new(rx * 2.0 * frame.scale, ry * 2.0 * frame.scale)))
    }

    fn sheen(frame: &Frame, head: &NSBezierPath) {
        let bounds = head.bounds();
        let colors: Vec<Retained<NSColor>> = mascot::SHEEN.iter().map(|(_, hex, alpha)| srgb(*hex, *alpha)).collect();
        let array = NSArray::from_retained_slice(&colors);
        let Some(gradient) = NSGradient::initWithColors(NSGradient::alloc(), &array) else { return };
        let center = NSPoint::new(bounds.origin.x + bounds.size.width * mascot::SHEEN_CENTER.0, bounds.origin.y + bounds.size.height * mascot::SHEEN_CENTER.1);
        let radius = mascot::SHEEN_RADIUS * (bounds.size.width + bounds.size.height) / 2.0;
        NSGraphicsContext::saveGraphicsState_class();
        head.addClip();
        gradient.drawFromCenter_radius_toCenter_radius_options(center, 0.0, center, radius, NSGradientDrawingOptions::DrawsAfterEndingLocation);
        NSGraphicsContext::restoreGraphicsState_class();
        let _ = frame;
    }

    pub fn draw(breed: &Breed, color: u32, bounds: NSRect) {
        let size = bounds.size.width.min(bounds.size.height);
        let frame = Frame { origin: bounds.origin, scale: size / 100.0 };
        fill(&frame, breed.back, color, false);
        let ears = |frame: &Frame| {
            fill(frame, breed.ears, color, false);
            fill(frame, breed.ears, color, true);
        };
        if !breed.ears_front {
            ears(&frame);
        }
        let head = path(&frame, breed.head, false);
        srgb(mascot::tone(color, Tone::Fur), 1.0).setFill();
        head.fill();
        if !breed.markings.is_empty() {
            NSGraphicsContext::saveGraphicsState_class();
            head.addClip();
            fill(&frame, breed.markings, color, false);
            NSGraphicsContext::restoreGraphicsState_class();
        }
        sheen(&frame, &head);
        fill(&frame, breed.muzzle, color, false);
        fill(&frame, breed.front, color, false);
        if breed.ears_front {
            ears(&frame);
        }
        for stroke in breed.details {
            let line = path(&frame, stroke.d, false);
            line.setLineWidth(stroke.width * frame.scale);
            line.setLineCapStyle(NSLineCapStyle::Round);
            line.setLineJoinStyle(NSLineJoinStyle::Round);
            srgb(mascot::tone(color, stroke.tone), 1.0).setStroke();
            line.stroke();
        }
        let eyes = breed.eyes;
        for cx in [eyes.x, 100.0 - eyes.x] {
            srgb(mascot::INK, 1.0).setFill();
            oval(&frame, cx, eyes.y, eyes.rx, eyes.ry).fill();
            if let Some(iris) = eyes.iris.and_then(mascot::iris) {
                srgb(iris, 1.0).setFill();
                oval(&frame, cx, eyes.y, eyes.rx * 0.74, eyes.ry * 0.74).fill();
                srgb(mascot::INK, 1.0).setFill();
                oval(&frame, cx, eyes.y, eyes.rx * 0.4, eyes.ry * 0.42).fill();
            }
            let glint = eyes.rx.min(eyes.ry) * 0.36;
            srgb(0xffffff, 1.0).setFill();
            oval(&frame, cx - eyes.rx * 0.3, eyes.y - eyes.ry * 0.36, glint, glint).fill();
        }
        let mouth = path(&frame, &mascot::mouth_path(breed.nose, breed.mouth), false);
        mouth.setLineWidth(mascot::MOUTH_WIDTH * frame.scale);
        mouth.setLineCapStyle(NSLineCapStyle::Round);
        mouth.setLineJoinStyle(NSLineJoinStyle::Round);
        srgb(mascot::INK, 1.0).setStroke();
        mouth.stroke();
        srgb(mascot::INK, 1.0).setFill();
        path(&frame, &mascot::nose_path(breed.nose), false).fill();
        let nose = breed.nose;
        srgb(0xffffff, 0.7).setFill();
        oval(&frame, 50.0 - nose.w * 0.17, nose.y - nose.h * 0.22, nose.w * 0.15, nose.h * 0.12).fill();
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

pub struct FadeIvars {
    color: Retained<NSColor>,
    edge: f64,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[ivars = FadeIvars]
    pub struct Fade;

    impl Fade {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            self.paint();
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView {
            std::ptr::null_mut()
        }
    }
);

impl Fade {
    pub fn new(mtm: MainThreadMarker, color: &NSColor, edge: f64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(FadeIvars { color: Retained::from(color), edge });
        unsafe { msg_send![super(this), initWithFrame: rect(0.0, 0.0, 10.0, 10.0)] }
    }

    fn paint(&self) {
        let bounds = self.bounds();
        let edge = self.ivars().edge.min(bounds.size.height);
        let solid = bounds.size.height - edge;
        let color = &self.ivars().color;
        color.setFill();
        NSBezierPath::fillRect(rect(0.0, 0.0, bounds.size.width, solid));
        let clear = color.colorWithAlphaComponent(0.0);
        let colors = objc2_foundation::NSArray::from_retained_slice(&[Retained::from(&**color), clear]);
        if let Some(gradient) = objc2_app_kit::NSGradient::initWithColors(objc2_app_kit::NSGradient::alloc(), &colors) {
            gradient.drawInRect_angle(rect(0.0, solid, bounds.size.width, edge), 90.0);
        }
    }
}
