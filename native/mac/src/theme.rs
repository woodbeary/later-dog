use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{NSAppearance, NSColor, NSFont, NSFontWeightMedium, NSFontWeightRegular, NSFontWeightSemibold};

pub const SIDEBAR_WIDTH: f64 = 320.0;
pub const TOP_BAR_HEIGHT: f64 = 46.0;
pub const TRAFFIC_LIGHT_X: f64 = 16.0;
pub const TRAFFIC_LIGHT_CENTER_Y: f64 = 23.0;
pub const SIDEBAR_LIST_INSET: f64 = 8.0;
pub const ROW_HEIGHT: f64 = 54.0;
pub const ROW_GAP: f64 = 2.0;
pub const ROW_RADIUS: f64 = 6.0;
pub const ROW_PAD_LEFT: f64 = 8.0;
pub const ROW_PAD_RIGHT: f64 = 36.0;
pub const ROW_AVATAR: f64 = 32.0;
pub const ROW_GAP_X: f64 = 12.0;
pub const DOT: f64 = 8.0;
pub const ICON_BUTTON: f64 = 32.0;
pub const FOOTER_HEIGHT: f64 = 36.0;
pub const FOOTER_PAD_X: f64 = 12.0;
pub const FOOTER_PAD_TOP: f64 = 8.0;
pub const FOOTER_PAD_BOTTOM: f64 = 12.0;
pub const FOOTER_GAP: f64 = 8.0;

pub const HEADER_PAD_X: f64 = 20.0;
pub const HEADER_PAD_Y: f64 = 12.0;
pub const HEADER_PILL_PAD: f64 = 6.0;
pub const HEADER_PILL_PAD_RIGHT: f64 = 14.0;
pub const HEADER_AVATAR: f64 = 24.0;
pub const HEADER_ICON_BUTTON: f64 = 30.0;

pub const TRANSCRIPT_PAD_X: f64 = 20.0;
pub const TRANSCRIPT_GAP: f64 = 12.0;
pub const BUBBLE_RADIUS: f64 = 18.0;
pub const BUBBLE_PAD_X: f64 = 12.0;
pub const BUBBLE_PAD_Y: f64 = 7.0;
pub const BUBBLE_MAX: f64 = 672.0;
pub const BUBBLE_MAX_SHARE: f64 = 0.78;
pub const BUBBLE_LINE: f64 = 21.0;
pub const DAY_PAD_Y: f64 = 12.0;
pub const DAY_LINE: f64 = 16.0;
pub const WORK_HEIGHT: f64 = 40.0;

pub const COMPOSER_PAD_X: f64 = 20.0;
pub const COMPOSER_PAD_BOTTOM: f64 = 12.0;
pub const COMPOSER_RADIUS: f64 = 22.0;
pub const COMPOSER_INSET_X: f64 = 8.0;
pub const COMPOSER_INSET_Y: f64 = 6.0;
pub const COMPOSER_CONTROL: f64 = 32.0;
pub const COMPOSER_LINE: f64 = 20.0;
pub const COMPOSER_MAX_TEXT: f64 = 144.0;
pub const HAIRLINE: f64 = 0.5;

pub const BUBBLE_TINTS: [(&str, u32); 10] = [
    ("green", 0x004e2a),
    ("blue", 0x184078),
    ("red", 0x712327),
    ("orange", 0x794315),
    ("purple", 0x402a68),
    ("cyan", 0x035467),
    ("pink", 0x712546),
    ("yellow", 0x715610),
    ("teal", 0x00544a),
    ("coral", 0x783025),
];

fn pick(table: &[(&str, u32)], name: &str) -> u32 {
    table
        .iter()
        .find(|(key, _)| *key == name)
        .or_else(|| table.iter().find(|(key, _)| *key == "yellow"))
        .map_or(0x808080, |(_, value)| *value)
}

pub fn srgb(hex: u32, alpha: f64) -> Retained<NSColor> {
    let channel = |shift: u32| f64::from((hex >> shift) & 0xff) / 255.0;
    NSColor::colorWithSRGBRed_green_blue_alpha(channel(16), channel(8), channel(0), alpha)
}

pub fn is_dark(appearance: &NSAppearance) -> bool {
    appearance.name().to_string().contains("Dark")
}

pub struct Tone {
    pub light: u32,
    pub light_alpha: f64,
    pub dark: u32,
    pub dark_alpha: f64,
}

const fn tone(light: u32, dark: u32) -> Tone {
    Tone { light, light_alpha: 1.0, dark, dark_alpha: 1.0 }
}

const fn faded(base: Tone, alpha: f64) -> Tone {
    Tone { light: base.light, light_alpha: base.light_alpha * alpha, dark: base.dark, dark_alpha: base.dark_alpha * alpha }
}

pub const APP: Tone = tone(0xfcfcfc, 0x070707);
pub const PANEL: Tone = tone(0xf7f7f7, 0x111111);
pub const RAISED: Tone = tone(0xe1e1e1, 0x2f2f2f);
pub const CARD: Tone = tone(0xeeeeee, 0x262626);
pub const COMPOSER: Tone = tone(0xfcfcfc, 0x2f2f2f);
pub const HAIRLINE_TONE: Tone = tone(0xd0d0d0, 0x333333);
pub const INK: Tone = tone(0x0d0d0d, 0xfcfcfc);
pub const INK_SECONDARY: Tone = Tone { light: 0x575757, light_alpha: 1.0, dark: 0xfcfcfc, dark_alpha: 0x99 as f64 / 255.0 };
pub const INK_TERTIARY: Tone = Tone { light: 0x5c5c5c, light_alpha: 1.0, dark: 0xfcfcfc, dark_alpha: 0x90 as f64 / 255.0 };
pub const ACCENT: Tone = tone(0x111111, 0xededed);
pub const ACCENT_INK: Tone = tone(0xffffff, 0x0d0d0d);
pub const UNREAD: Tone = tone(0x007aff, 0x0a84ff);
pub const WAITING: Tone = tone(0xe0530a, 0xff9f0a);
pub const INSET: Tone = tone(0xe6e6e6, 0x191919);
pub const SUCCESS: Tone = tone(0x1f7a4d, 0x38d591);

pub fn dynamic(tone: &Tone) -> Retained<NSColor> {
    let light = srgb(tone.light, tone.light_alpha);
    let dark = srgb(tone.dark, tone.dark_alpha);
    let provider = RcBlock::new(move |appearance: NonNull<NSAppearance>| -> NonNull<NSColor> {
        let chosen = if is_dark(unsafe { appearance.as_ref() }) { &dark } else { &light };
        NonNull::from(&**chosen)
    });
    unsafe { NSColor::colorWithName_dynamicProvider(None, &provider) }
}

pub struct Theme {
    pub app: Retained<NSColor>,
    pub panel: Retained<NSColor>,
    pub selected_row: Retained<NSColor>,
    pub raised: Retained<NSColor>,
    pub card: Retained<NSColor>,
    pub composer: Retained<NSColor>,
    pub hairline_side: Retained<NSColor>,
    pub hairline_pill: Retained<NSColor>,
    pub head_ring: Retained<NSColor>,
    pub composer_ring: Retained<NSColor>,
    pub ink: Retained<NSColor>,
    pub ink_secondary: Retained<NSColor>,
    pub ink_tertiary: Retained<NSColor>,
    pub accent: Retained<NSColor>,
    pub accent_ink: Retained<NSColor>,
    pub unread: Retained<NSColor>,
    pub waiting: Retained<NSColor>,
    pub white: Retained<NSColor>,
    pub inset: Retained<NSColor>,
    pub hairline: Retained<NSColor>,
    pub hairline_40: Retained<NSColor>,
    pub hairline_30: Retained<NSColor>,
    pub raised_30: Retained<NSColor>,
    pub link_line: Retained<NSColor>,
    pub success: Retained<NSColor>,
}

impl Theme {
    pub fn new() -> Self {
        Theme {
            app: dynamic(&APP),
            panel: dynamic(&PANEL),
            selected_row: dynamic(&faded(RAISED, 0.7)),
            raised: dynamic(&RAISED),
            card: dynamic(&CARD),
            composer: dynamic(&COMPOSER),
            hairline_side: dynamic(&faded(HAIRLINE_TONE, 0.4)),
            hairline_pill: dynamic(&faded(HAIRLINE_TONE, 0.5)),
            head_ring: dynamic(&faded(INK, 0.1)),
            composer_ring: dynamic(&faded(INK, 0.3)),
            ink: dynamic(&INK),
            ink_secondary: dynamic(&INK_SECONDARY),
            ink_tertiary: dynamic(&INK_TERTIARY),
            accent: dynamic(&ACCENT),
            accent_ink: dynamic(&ACCENT_INK),
            unread: dynamic(&UNREAD),
            waiting: dynamic(&WAITING),
            white: srgb(0xffffff, 1.0),
            inset: dynamic(&INSET),
            hairline: dynamic(&HAIRLINE_TONE),
            hairline_40: dynamic(&faded(HAIRLINE_TONE, 0.4)),
            hairline_30: dynamic(&faded(HAIRLINE_TONE, 0.3)),
            raised_30: dynamic(&faded(RAISED, 0.3)),
            link_line: dynamic(&faded(ACCENT, 0.4)),
            success: dynamic(&SUCCESS),
        }
    }

    pub fn tint(&self, color: &str) -> Retained<NSColor> {
        srgb(pick(&BUBBLE_TINTS, color), 1.0)
    }
}

pub fn font(size: f64, weight: Weight) -> Retained<NSFont> {
    let weight = unsafe {
        match weight {
            Weight::Regular => NSFontWeightRegular,
            Weight::Medium => NSFontWeightMedium,
            Weight::Semibold => NSFontWeightSemibold,
        }
    };
    NSFont::systemFontOfSize_weight(size, weight)
}

#[derive(Clone, Copy)]
pub enum Weight {
    Regular,
    Medium,
    Semibold,
}

pub fn model_name(model: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut version: Vec<&str> = Vec::new();
    for part in model.split(['-', '_']).filter(|part| !part.is_empty()) {
        if part.chars().all(|c| c.is_ascii_digit()) {
            version.push(part);
            continue;
        }
        if !version.is_empty() {
            words.push(version.join("."));
            version.clear();
        }
        let mut chars = part.chars();
        let first = chars.next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default();
        words.push(format!("{first}{}", chars.as_str()));
    }
    if !version.is_empty() {
        words.push(version.join("."));
    }
    words.join(" ")
}
