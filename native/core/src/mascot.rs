#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Fur,
    Shade,
    Dark,
    Deep,
    Light,
    White,
    Inner,
    Ink,
}

#[derive(Clone, Copy, Debug)]
pub struct Shape {
    pub tone: Tone,
    pub d: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub struct Stroke {
    pub tone: Tone,
    pub width: f64,
    pub d: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub struct Eyes {
    pub x: f64,
    pub y: f64,
    pub rx: f64,
    pub ry: f64,
    pub iris: Option<&'static str>,
}

#[derive(Clone, Copy, Debug)]
pub struct Nose {
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Mouth {
    pub y: f64,
    pub w: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Breed {
    pub id: &'static str,
    pub name: &'static str,
    pub head: &'static str,
    pub markings: &'static [Shape],
    pub muzzle: &'static [Shape],
    pub back: &'static [Shape],
    pub front: &'static [Shape],
    pub details: &'static [Stroke],
    pub ears_front: bool,
    pub ears: &'static [Shape],
    pub eyes: Eyes,
    pub nose: Nose,
    pub mouth: Mouth,
}

pub const DEFAULT_BODY: &str = "dog";
pub const DEFAULT_COLOR: &str = "yellow";
pub const INK: u32 = 0x1c1816;
pub const MOUTH_WIDTH: f64 = 2.0;
pub const SHEEN: [(f64, u32, f64); 3] = [(0.0, 0xffffff, 0.22), (0.5, 0xffffff, 0.05), (1.0, 0x000000, 0.08)];
pub const SHEEN_CENTER: (f64, f64) = (0.34, 0.24);
pub const SHEEN_RADIUS: f64 = 0.78;

pub const DOG_COLORS: [(&str, u32); 10] = [
    ("green", 0x009957),
    ("blue", 0x377FE6),
    ("red", 0xD94B52),
    ("orange", 0xE78531),
    ("purple", 0x8057C8),
    ("cyan", 0x0EA5C6),
    ("pink", 0xD84F8B),
    ("yellow", 0xD8A729),
    ("teal", 0x01A492),
    ("coral", 0xE5634E),
];

pub const MASCOT_BODIES: [&str; 16] = [
    "dog", "beagle", "shepherd", "corgi", "husky", "pug", "poodle", "chihuahua", "blob", "circle", "squircle", "capsule", "drop", "shield", "hexagon", "diamond",
];

pub fn dog_color(name: &str) -> u32 {
    DOG_COLORS
        .iter()
        .find(|(key, _)| *key == name)
        .or_else(|| DOG_COLORS.iter().find(|(key, _)| *key == DEFAULT_COLOR))
        .map_or(0xD8A729, |(_, value)| *value)
}

pub fn body(value: Option<&str>) -> &'static str {
    value.and_then(|wanted| MASCOT_BODIES.iter().copied().find(|body| *body == wanted)).unwrap_or(DEFAULT_BODY)
}

pub fn breed(value: Option<&str>) -> Option<&'static Breed> {
    let wanted = body(value);
    BREEDS.iter().find(|breed| breed.id == wanted)
}

fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn n(value: f64) -> String {
    let rounded = round(value);
    if rounded == rounded.trunc() {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}")
    }
}

pub fn nose_path(nose: Nose) -> String {
    let Nose { y, w, h } = nose;
    let (l, r, t, b) = (50.0 - w / 2.0, 50.0 + w / 2.0, y - h / 2.0, y + h / 2.0);
    format!(
        "M{} {}C{} {} {} {} 50 {}C{} {} {} {} {} {}C{} {} {} {} 50 {}C{} {} {} {} {} {}Z",
        n(l), n(y - h * 0.22), n(l), n(t + h * 0.02), n(50.0 - w * 0.3), n(t), n(t),
        n(50.0 + w * 0.3), n(t), n(r), n(t + h * 0.02), n(r), n(y - h * 0.22),
        n(r), n(y + h * 0.12), n(50.0 + w * 0.2), n(b - h * 0.04), n(b),
        n(50.0 - w * 0.2), n(b - h * 0.04), n(l), n(y + h * 0.12), n(l), n(y - h * 0.22),
    )
}

pub fn mouth_path(nose: Nose, mouth: Mouth) -> String {
    let top = nose.y + nose.h / 2.0 - 0.6;
    let join = mouth.y - 2.6;
    let Mouth { y, w } = mouth;
    format!(
        "M50 {}L50 {}M{} {}Q{} {} 50 {}Q{} {} {} {}",
        n(top), n(join), n(50.0 - w), n(y - 2.4), n(50.0 - w * 0.42), n(y + 1.9), n(join), n(50.0 + w * 0.42), n(y + 1.9), n(50.0 + w), n(y - 2.4),
    )
}

fn to_linear(channel: f64) -> f64 {
    if channel <= 0.04045 { channel / 12.92 } else { ((channel + 0.055) / 1.055).powf(2.4) }
}

fn to_srgb(channel: f64) -> f64 {
    let value = if channel <= 0.0031308 { channel * 12.92 } else { 1.055 * channel.powf(1.0 / 2.4) - 0.055 };
    value.clamp(0.0, 1.0)
}

fn oklab(hex: u32) -> [f64; 3] {
    let [r, g, b] = [16, 8, 0].map(|shift| to_linear(f64::from((hex >> shift) & 0xff) / 255.0));
    let l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b).cbrt();
    let m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b).cbrt();
    let s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b).cbrt();
    [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ]
}

fn from_oklab([lightness, a, b]: [f64; 3]) -> u32 {
    let l = (lightness + 0.3963377774 * a + 0.2158037573 * b).powi(3);
    let m = (lightness - 0.1055613458 * a - 0.0638541728 * b).powi(3);
    let s = (lightness - 0.0894841775 * a - 1.2914855480 * b).powi(3);
    let channels = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
    channels.iter().fold(0u32, |hex, channel| (hex << 8) | (to_srgb(*channel) * 255.0).round() as u32)
}

pub fn mix(color: u32, share: f64, other: u32) -> u32 {
    let (first, second) = (oklab(color), oklab(other));
    from_oklab([0, 1, 2].map(|index| first[index] * share + second[index] * (1.0 - share)))
}

pub fn tone(color: u32, tone: Tone) -> u32 {
    match tone {
        Tone::Fur => color,
        Tone::Shade => mix(color, 0.80, 0x000000),
        Tone::Dark => mix(color, 0.52, 0x000000),
        Tone::Deep => mix(color, 0.24, 0x100d0c),
        Tone::Light => mix(color, 0.42, 0xffffff),
        Tone::White => mix(color, 0.10, 0xfffaf3),
        Tone::Inner => mix(color, 0.35, 0xf4b4ae),
        Tone::Ink => INK,
    }
}

pub fn iris(hex: &str) -> Option<u32> {
    u32::from_str_radix(hex.strip_prefix('#')?, 16).ok()
}

pub fn every_path(breed: &Breed) -> Vec<String> {
    let shapes = breed.markings.iter().chain(breed.muzzle).chain(breed.back).chain(breed.front).chain(breed.ears);
    let mut paths: Vec<String> = std::iter::once(breed.head.to_owned()).chain(shapes.map(|shape| shape.d.to_owned())).collect();
    paths.extend(breed.details.iter().map(|stroke| stroke.d.to_owned()));
    paths.push(nose_path(breed.nose));
    paths.push(mouth_path(breed.nose, breed.mouth));
    paths
}

pub const BREEDS: [Breed; 8] = [
    Breed {
        id: "dog",
        name: "Retriever",
        head: "M50 19C63 19 73 24 78 33C82 40 83 49 82 57C81 66 76 74 68 79C63 83 57 85 50 85C43 85 37 83 32 79C24 74 19 66 18 57C17 49 18 40 22 33C27 24 37 19 50 19Z",
        markings: &[],
        muzzle: &[Shape { tone: Tone::White, d: "M50 55.5C58.5 55.5 65 59.5 67 65.5C69 72.5 65 79.5 58.5 83C55.5 84.5 44.5 84.5 41.5 83C35 79.5 31 72.5 33 65.5C35 59.5 41.5 55.5 50 55.5Z" }],
        back: &[],
        front: &[],
        details: &[],
        ears_front: true,
        ears: &[Shape { tone: Tone::Shade, d: "M31.5 27C24 25.5 16.5 29 13.5 36.5C10.5 44 10.5 55 12.5 63C14 69.5 17.5 74 22 73.5C26.5 73 28.5 68.5 28.5 63C28.5 56 27 49.5 27.3 43.5C27.6 37.5 29.2 31.5 31.5 27Z" }],
        eyes: Eyes { x: 38.5, y: 47.0, rx: 4.3, ry: 4.7, iris: None },
        nose: Nose { y: 62.5, w: 15.0, h: 10.0 },
        mouth: Mouth { y: 73.0, w: 7.5 },
    },
    Breed {
        id: "beagle",
        name: "Beagle",
        head: "M50 20C62 20 71 25 75.5 34C79.5 42 80 51 79 59C78 68 73 76 66 80.5C61 83.5 56 85 50 85C44 85 39 83.5 34 80.5C27 76 22 68 21 59C20 51 20.5 42 24.5 34C29 25 38 20 50 20Z",
        markings: &[Shape { tone: Tone::White, d: "M50 23C52.5 23 53.6 28 54 34C54.4 40 54.5 45 56.5 50C59 55 66 58 68 64C70.5 72 66 80 58 83.5C55 85 45 85 42 83.5C34 80 29.5 72 32 64C34 58 41 55 43.5 50C45.5 45 45.6 40 46 34C46.4 28 47.5 23 50 23Z" }],
        muzzle: &[Shape { tone: Tone::White, d: "M50 56C57.5 56 63.5 60 65.5 65.5C67.5 72 64 78.5 58 81.5C55 83 45 83 42 81.5C36 78.5 32.5 72 34.5 65.5C36.5 60 42.5 56 50 56Z" }],
        back: &[],
        front: &[],
        details: &[],
        ears_front: true,
        ears: &[Shape { tone: Tone::Dark, d: "M35 27C26 25.5 16.5 30.5 13 40.5C9.5 50 9.5 64 11.5 74C13 81.5 17 87.5 22.5 87.5C28 87.5 30.5 81 30.5 73.5C30.5 63 28.5 53 29 45C29.5 37.5 31.5 31 35 27Z" }],
        eyes: Eyes { x: 38.0, y: 48.5, rx: 4.6, ry: 5.0, iris: None },
        nose: Nose { y: 63.5, w: 14.0, h: 9.5 },
        mouth: Mouth { y: 73.5, w: 7.0 },
    },
    Breed {
        id: "shepherd",
        name: "Shepherd",
        head: "M50 25.5C62 25.5 72.5 29 77.5 36.5C81 42 81 50 79.5 57C78 64.5 73.5 71 68 77C63.5 82 57.5 88 50 88C42.5 88 36.5 82 32 77C26.5 71 22 64.5 20.5 57C19 50 19 42 22.5 36.5C27.5 29 38 25.5 50 25.5Z",
        markings: &[Shape { tone: Tone::Deep, d: "M13 10H87V37.5C81 38.5 74 41.5 68.8 44.8C70 41.5 67.5 35.6 62.5 35.5C58.5 35.4 56.2 37.5 55.5 40.5C54.5 44 52 47.5 50 49.5C48 47.5 45.5 44 44.5 40.5C43.8 37.5 41.5 35.4 37.5 35.5C32.5 35.6 30 41.5 31.2 44.8C26 41.5 19 38.5 13 37.5Z" }],
        muzzle: &[Shape { tone: Tone::Dark, d: "M50 41.5C53.2 41.5 54.6 45 55.5 49C56.5 53.5 59.5 57.5 61.8 61.5C64.5 66.5 65.2 73 64 78.5C62.5 84.5 57 88 50 88C43 88 37.5 84.5 36 78.5C34.8 73 35.5 66.5 38.2 61.5C40.5 57.5 43.5 53.5 44.5 49C45.4 45 46.8 41.5 50 41.5Z" }],
        back: &[],
        front: &[],
        details: &[],
        ears_front: false,
        ears: &[Shape { tone: Tone::Dark, d: "M28.5 42C25 37 22 26 21.5 14C21.3 9 21.8 5.5 23.5 4.5C25.5 3.5 27.5 5 29.5 7C35 12.5 41.5 19.5 46 26.5C47 28 47 31 45.5 33C40 37 34 40 28.5 42Z" }, Shape { tone: Tone::Inner, d: "M30 37C27.5 31 25.5 23 25.3 16C25.2 12.5 26 10.5 27.5 11.3C32 15 37.5 21 41.5 28C38 32 34 35 30 37Z" }],
        eyes: Eyes { x: 37.5, y: 47.0, rx: 4.2, ry: 4.6, iris: None },
        nose: Nose { y: 66.0, w: 14.5, h: 9.8 },
        mouth: Mouth { y: 78.0, w: 7.5 },
    },
    Breed {
        id: "corgi",
        name: "Corgi",
        head: "M50 28C63 28 73.5 31.5 79 39C84.5 46.5 87 54 86 61C85 68 79.5 76 71 82C64.5 86.5 57.5 90 50 90C42.5 90 35.5 86.5 29 82C20.5 76 15 68 14 61C13 54 15.5 46.5 21 39C26.5 31.5 37 28 50 28Z",
        markings: &[Shape { tone: Tone::White, d: "M50 29.5C52 29.5 53 33 53.5 38.5C54 45 54 50.5 55.2 55C56.5 59.5 60 61 64.5 61C70.5 61 75 65 76 71C77 77 76 80 80 84L80 96L20 96L20 84C24 80 23 77 24 71C25 65 29.5 61 35.5 61C40 61 43.5 59.5 44.8 55C46 50.5 46 45 46.5 38.5C47 33 48 29.5 50 29.5Z" }],
        muzzle: &[],
        back: &[],
        front: &[],
        details: &[],
        ears_front: false,
        ears: &[Shape { tone: Tone::Fur, d: "M22 52C18.5 41 14 27 13.2 16C12.6 8.5 16.5 3.5 22.5 5C30.5 7 39.5 16 44.5 25.5C46.5 29.5 48 34.5 48.5 40C40 45 31 49.5 22 52Z" }, Shape { tone: Tone::Inner, d: "M25.5 48C22.5 39 19 29 18.6 20C18.3 14.5 21.5 11.5 26 13C32 15.5 37.5 22.5 40.5 29.5C42 33 43 37 43.5 41C37.5 44 31.5 46.5 25.5 48Z" }],
        eyes: Eyes { x: 38.5, y: 52.5, rx: 4.8, ry: 5.1, iris: None },
        nose: Nose { y: 68.0, w: 14.0, h: 9.5 },
        mouth: Mouth { y: 78.5, w: 8.0 },
    },
    Breed {
        id: "husky",
        name: "Husky",
        head: "M50 24C61 24 70.5 28 75.5 35.5C80 42 81 50 80.5 58C80 66 76 73 70 78C65 82 58 86.5 50 86.5C42 86.5 35 82 30 78C24 73 20 66 19.5 58C19 50 20 42 24.5 35.5C29.5 28 39 24 50 24Z",
        markings: &[Shape { tone: Tone::White, d: "M50 51.5C51.5 48.5 53 45 54 42C55 39.5 57.5 37.8 61.5 37.8C66.5 37.8 71.5 38.7 75 41C72.2 43 69.7 45 67.8 47.8C70.5 46.7 73.7 46 76.5 46C76.7 48.5 76.5 51.5 76.5 55C76.5 58.5 74.5 61.5 73 65.5C72 68.5 69.5 72 66 76C62.5 80.5 57.5 85.5 50 85.5C42.5 85.5 37.5 80.5 34 76C30.5 72 28 68.5 27 65.5C25.5 61.5 23.5 58.5 23.5 55C23.5 51.5 23.3 48.5 23.5 46C26.3 46 29.5 46.7 32.2 47.8C30.3 45 27.8 43 25 41C28.5 38.7 33.5 37.8 38.5 37.8C42.5 37.8 45 39.5 46 42C47 45 48.5 48.5 50 51.5Z" }, Shape { tone: Tone::White, d: "M35.8 33A3.2 2 0 1 0 42.2 33A3.2 2 0 1 0 35.8 33Z" }, Shape { tone: Tone::White, d: "M57.8 33A3.2 2 0 1 0 64.2 33A3.2 2 0 1 0 57.8 33Z" }],
        muzzle: &[],
        back: &[],
        front: &[],
        details: &[],
        ears_front: false,
        ears: &[Shape { tone: Tone::Shade, d: "M28.5 38C26.8 30.5 27 19 29.5 11.5C30.6 8.6 33.8 7.6 36.2 9.8C41 14.3 45.2 20 48 25.8C48.7 27.4 48.4 30.2 47 31.5C41.5 34.5 35 36.5 28.5 38Z" }, Shape { tone: Tone::White, d: "M32.5 33.5C31.8 27.5 32.2 21.5 33.8 16.8C34.4 15.2 36 14.8 37.1 15.9C40 18.9 42.3 22.3 43.9 25.9C40.5 28.8 36.7 31.4 32.5 33.5Z" }],
        eyes: Eyes { x: 38.5, y: 48.5, rx: 4.9, ry: 5.2, iris: Some("#8fd0ff") },
        nose: Nose { y: 64.5, w: 13.5, h: 9.0 },
        mouth: Mouth { y: 75.0, w: 7.0 },
    },
    Breed {
        id: "pug",
        name: "Pug",
        head: "M50 20.5C37.5 20.5 27 22.5 21 28C15.5 33 13.5 41.5 13.5 51C13.5 61 16 70 21.5 76.5C27 82.5 37.5 85.5 50 85.5C62.5 85.5 73 82.5 78.5 76.5C84 70 86.5 61 86.5 51C86.5 41.5 84.5 33 79 28C73 22.5 62.5 20.5 50 20.5Z",
        markings: &[Shape { tone: Tone::Deep, d: "M50 40C46.5 40 40.2 41.5 40.2 46C40.2 49.4 37.4 52.2 34 52.2C30.6 52.2 27.8 49.4 27.8 46C27.8 44.6 27.2 43.6 26.3 43.6C25.3 43.6 24.8 45.5 25 48.5C25.3 53.5 27.3 59 29.5 64.5C31.5 70.5 35.5 76 41 76.8C44.8 77.2 48 76.5 50 75C52 76.5 55.2 77.2 59 76.8C64.5 76 68.5 70.5 70.5 64.5C72.7 59 74.7 53.5 75 48.5C75.2 45.5 74.7 43.6 73.7 43.6C72.8 43.6 72.2 44.6 72.2 46C72.2 49.4 69.4 52.2 66 52.2C62.6 52.2 59.8 49.4 59.8 46C59.8 41.5 53.5 40 50 40Z" }],
        muzzle: &[],
        back: &[],
        front: &[],
        details: &[Stroke { tone: Tone::Dark, width: 1.9, d: "M45 30C47.5 28.2 52.5 28.2 55 30" }, Stroke { tone: Tone::Dark, width: 1.9, d: "M44 34.8C45.6 33.1 48.3 33.1 50 34.6C51.7 33.1 54.4 33.1 56 34.8" }, Stroke { tone: Tone::Shade, width: 2.2, d: "M43 50.5C45.5 47 54.5 47 57 50.5" }],
        ears_front: true,
        ears: &[Shape { tone: Tone::Deep, d: "M15 31C18 25 26 20.5 35.5 20C34 27 29.5 35.5 23.5 42.5C21.5 44.5 19 44 17.8 41.5C16 38 15 34.5 15 31Z" }, Shape { tone: Tone::Dark, d: "M15 31C18 25 26 20.5 35.5 20C27.5 22.5 21 26.5 17.3 33.5C16.2 33 15 32.2 15 31Z" }],
        eyes: Eyes { x: 34.0, y: 46.0, rx: 6.5, ry: 6.5, iris: None },
        nose: Nose { y: 55.5, w: 12.0, h: 8.0 },
        mouth: Mouth { y: 67.0, w: 8.5 },
    },
    Breed {
        id: "poodle",
        name: "Poodle",
        head: "M50 30C39.5 30 32 35 31 43.5C30 51.5 32.5 58 36 64C38.5 68.5 39.5 75 40 80C40.5 85 44.5 87.5 50 87.5C55.5 87.5 59.5 85 60 80C60.5 75 61.5 68.5 64 64C67.5 58 70 51.5 69 43.5C68 35 60.5 30 50 30Z",
        markings: &[],
        muzzle: &[],
        back: &[],
        front: &[Shape { tone: Tone::Shade, d: "M43.5 10.8A6.8 6.8 0 1 0 57.1 10.8A6.8 6.8 0 1 0 43.5 10.8ZM51.9 13.4A6.8 6.8 0 1 0 65.5 13.4A6.8 6.8 0 1 0 51.9 13.4ZM56.3 19.9A6.8 6.8 0 1 0 69.9 19.9A6.8 6.8 0 1 0 56.3 19.9ZM54.8 27.3A6.8 6.8 0 1 0 68.4 27.3A6.8 6.8 0 1 0 54.8 27.3ZM47.9 32.1A6.8 6.8 0 1 0 61.5 32.1A6.8 6.8 0 1 0 47.9 32.1ZM39.1 32.1A6.8 6.8 0 1 0 52.7 32.1A6.8 6.8 0 1 0 39.1 32.1ZM32.2 27.3A6.8 6.8 0 1 0 45.8 27.3A6.8 6.8 0 1 0 32.2 27.3ZM30.7 19.9A6.8 6.8 0 1 0 44.3 19.9A6.8 6.8 0 1 0 30.7 19.9ZM35.1 13.4A6.8 6.8 0 1 0 48.7 13.4A6.8 6.8 0 1 0 35.1 13.4ZM38.5 21.8A11.8 11.8 0 1 0 62.1 21.8A11.8 11.8 0 1 0 38.5 21.8Z" }, Shape { tone: Tone::Fur, d: "M43.5 9.5A6.5 6.5 0 1 0 56.5 9.5A6.5 6.5 0 1 0 43.5 9.5ZM51.9 12.1A6.5 6.5 0 1 0 64.9 12.1A6.5 6.5 0 1 0 51.9 12.1ZM56.3 18.6A6.5 6.5 0 1 0 69.3 18.6A6.5 6.5 0 1 0 56.3 18.6ZM54.8 26A6.5 6.5 0 1 0 67.8 26A6.5 6.5 0 1 0 54.8 26ZM47.9 30.8A6.5 6.5 0 1 0 60.9 30.8A6.5 6.5 0 1 0 47.9 30.8ZM39.1 30.8A6.5 6.5 0 1 0 52.1 30.8A6.5 6.5 0 1 0 39.1 30.8ZM32.2 26A6.5 6.5 0 1 0 45.2 26A6.5 6.5 0 1 0 32.2 26ZM30.7 18.6A6.5 6.5 0 1 0 43.7 18.6A6.5 6.5 0 1 0 30.7 18.6ZM35.1 12.1A6.5 6.5 0 1 0 48.1 12.1A6.5 6.5 0 1 0 35.1 12.1ZM38.5 20.5A11.5 11.5 0 1 0 61.5 20.5A11.5 11.5 0 1 0 38.5 20.5Z" }, Shape { tone: Tone::Shade, d: "M47.3 16.3A4.2 4.2 0 0 1 39.7 16.3A8.3 8.3 0 0 0 47.3 16.3ZM58 17.5A4 4 0 0 1 52.9 11.4A5 5 0 0 0 58 17.5ZM53.6 23.4A4.5 4.5 0 0 1 45.4 23.4A8.8 8.8 0 0 0 53.6 23.4ZM41.4 27.8A4 4 0 0 1 37.4 20.9A5 5 0 0 0 41.4 27.8ZM63.1 24.7A4 4 0 0 1 55.9 24.7A7.7 7.7 0 0 0 63.1 24.7ZM54.1 31.3A3.8 3.8 0 0 1 47.6 32.4A9.3 9.3 0 0 0 54.1 31.3Z" }, Shape { tone: Tone::Light, d: "M38.1 11.1A4.2 4.2 0 0 1 43.4 8.6ZM46.9 7.4A4.2 4.2 0 0 1 52.6 5.9ZM32.6 18.8A4 4 0 0 1 36.5 15.5Z" }],
        details: &[],
        ears_front: true,
        ears: &[Shape { tone: Tone::Shade, d: "M23.5 44.3A5.8 5.8 0 1 0 35.1 44.3A5.8 5.8 0 1 0 23.5 44.3ZM16 46.3A6.8 6.8 0 1 0 29.6 46.3A6.8 6.8 0 1 0 16 46.3ZM11.5 53.3A6.8 6.8 0 1 0 25.1 53.3A6.8 6.8 0 1 0 11.5 53.3ZM10 62.3A6.8 6.8 0 1 0 23.6 62.3A6.8 6.8 0 1 0 10 62.3ZM10.5 71.3A6.8 6.8 0 1 0 24.1 71.3A6.8 6.8 0 1 0 10.5 71.3ZM13.5 79.3A6.8 6.8 0 1 0 27.1 79.3A6.8 6.8 0 1 0 13.5 79.3ZM21 82.3A6.3 6.3 0 1 0 33.6 82.3A6.3 6.3 0 1 0 21 82.3ZM24 75.3A5.8 5.8 0 1 0 35.6 75.3A5.8 5.8 0 1 0 24 75.3ZM24.5 65.3A5.8 5.8 0 1 0 36.1 65.3A5.8 5.8 0 1 0 24.5 65.3ZM24.5 54.3A5.8 5.8 0 1 0 36.1 54.3A5.8 5.8 0 1 0 24.5 54.3ZM14 63.3A9.8 9.8 0 1 0 33.6 63.3A9.8 9.8 0 1 0 14 63.3ZM16.5 51.3A7.8 7.8 0 1 0 32.1 51.3A7.8 7.8 0 1 0 16.5 51.3ZM15.5 73.3A8.3 8.3 0 1 0 32.1 73.3A8.3 8.3 0 1 0 15.5 73.3Z" }, Shape { tone: Tone::Fur, d: "M23 43A5.5 5.5 0 1 0 34 43A5.5 5.5 0 1 0 23 43ZM15.5 45A6.5 6.5 0 1 0 28.5 45A6.5 6.5 0 1 0 15.5 45ZM11 52A6.5 6.5 0 1 0 24 52A6.5 6.5 0 1 0 11 52ZM9.5 61A6.5 6.5 0 1 0 22.5 61A6.5 6.5 0 1 0 9.5 61ZM10 70A6.5 6.5 0 1 0 23 70A6.5 6.5 0 1 0 10 70ZM13 78A6.5 6.5 0 1 0 26 78A6.5 6.5 0 1 0 13 78ZM20.5 81A6 6 0 1 0 32.5 81A6 6 0 1 0 20.5 81ZM23.5 74A5.5 5.5 0 1 0 34.5 74A5.5 5.5 0 1 0 23.5 74ZM24 64A5.5 5.5 0 1 0 35 64A5.5 5.5 0 1 0 24 64ZM24 53A5.5 5.5 0 1 0 35 53A5.5 5.5 0 1 0 24 53ZM13.5 62A9.5 9.5 0 1 0 32.5 62A9.5 9.5 0 1 0 13.5 62ZM16 50A7.5 7.5 0 1 0 31 50A7.5 7.5 0 1 0 16 50ZM15 72A8 8 0 1 0 31 72A8 8 0 1 0 15 72Z" }, Shape { tone: Tone::Shade, d: "M27.1 50.9A4.5 4.5 0 0 1 18.9 50.9A8.1 8.1 0 0 0 27.1 50.9ZM22.1 64.3A4.6 4.6 0 0 1 17.5 56.5A5.6 5.6 0 0 0 22.1 64.3ZM28.1 72.4A4.5 4.5 0 0 1 19.9 72.4A8.1 8.1 0 0 0 28.1 72.4ZM31.2 59.2A3.4 3.4 0 0 1 25.1 59.7A6.6 6.6 0 0 0 31.2 59.2ZM22.9 80.2A3.6 3.6 0 0 1 16.7 81.3A8.4 8.4 0 0 0 22.9 80.2Z" }, Shape { tone: Tone::Light, d: "M17.7 43.4A4.6 4.6 0 0 1 23.6 40.7ZM12.2 58.7A4.4 4.4 0 0 1 16.5 55.1Z" }],
        eyes: Eyes { x: 41.5, y: 48.5, rx: 4.1, ry: 3.2, iris: None },
        nose: Nose { y: 71.0, w: 11.0, h: 7.5 },
        mouth: Mouth { y: 80.0, w: 6.5 },
    },
    Breed {
        id: "chihuahua",
        name: "Chihuahua",
        head: "M50 30.5C65.5 30.5 78.5 41.5 78.5 56.5C78.5 66 74 74 67 79.5C62 83.5 56.5 86 50 86C43.5 86 38 83.5 33 79.5C26 74 21.5 66 21.5 56.5C21.5 41.5 34.5 30.5 50 30.5Z",
        markings: &[],
        muzzle: &[Shape { tone: Tone::Light, d: "M50 58C54.5 58 57 61 59.5 64.5C62.5 68.5 64.5 72 64 76C63.5 81 57.5 85.5 50 85.5C42.5 85.5 36.5 81 36 76C35.5 72 37.5 68.5 40.5 64.5C43 61 45.5 58 50 58Z" }],
        back: &[],
        front: &[],
        details: &[],
        ears_front: false,
        ears: &[Shape { tone: Tone::Fur, d: "M28.6 60.6C19 51.2 10.6 38.8 7.7 26.9C6.2 20 8.2 12.4 14.2 11.5C22.6 10.4 31.6 17.3 37.8 26.8C40.6 31.2 43 36.5 44.4 42.4C38.9 49.8 33.8 56.2 28.6 60.6Z" }, Shape { tone: Tone::Inner, d: "M30.3 55.9C22.2 48 16 37.9 13.4 29.1C12 24.1 14.2 19.5 18.7 19.2C25.2 19.2 31.1 24.3 35.5 30.5C38.3 34.3 40.1 38.7 41 43.7C37.3 48.4 34.1 52.7 30.3 55.9Z" }],
        eyes: Eyes { x: 36.0, y: 56.5, rx: 6.4, ry: 6.7, iris: None },
        nose: Nose { y: 70.0, w: 12.5, h: 8.4 },
        mouth: Mouth { y: 78.5, w: 6.5 },
    },
];
