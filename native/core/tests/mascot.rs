use laterdog_core::mascot::{body, breed, dog_color, every_path, mix, mouth_path, nose_path, tone, Tone, BREEDS};
use laterdog_core::path::{bounds, parse, Point, Segment};

#[test]
fn every_path_of_every_breed_parses_inside_the_face() {
    for breed in &BREEDS {
        for data in every_path(breed) {
            let segments = parse(&data).unwrap_or_else(|error| panic!("{} {data}: {error:?}", breed.id));
            assert!(matches!(segments.first(), Some(Segment::Move(_))), "{} {data}", breed.id);
            let (low, high) = bounds(&segments).expect("a path has points");
            assert!(low.x >= -5.0 && low.y >= -5.0 && high.x <= 105.0 && high.y <= 105.0, "{} {data} {low:?} {high:?}", breed.id);
        }
    }
}

#[test]
fn the_breeds_are_the_desktop_breeds_with_the_desktop_paths() {
    let ids: Vec<&str> = BREEDS.iter().map(|breed| breed.id).collect();
    assert_eq!(ids, ["dog", "beagle", "shepherd", "corgi", "husky", "pug", "poodle", "chihuahua"]);
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/components/dog-breeds.ts"));
    let Ok(source) = source else { return };
    for breed in &BREEDS {
        let shapes = breed.markings.iter().chain(breed.muzzle).chain(breed.back).chain(breed.front).chain(breed.ears).map(|shape| shape.d);
        for data in std::iter::once(breed.head).chain(shapes).chain(breed.details.iter().map(|stroke| stroke.d)) {
            assert!(source.contains(data), "{} drifted from the desktop: {data}", breed.id);
        }
    }
}

#[test]
fn nose_and_mouth_follow_the_desktop_geometry() {
    let retriever = breed(None).expect("the default body is a breed");
    assert_eq!(
        nose_path(retriever.nose),
        "M42.5 60.3C42.5 57.7 45.5 57.5 50 57.5C54.5 57.5 57.5 57.7 57.5 60.3C57.5 63.7 53 67.1 50 67.5C47 67.1 42.5 63.7 42.5 60.3Z"
    );
    assert_eq!(mouth_path(retriever.nose, retriever.mouth), "M50 66.9L50 70.4M42.5 70.6Q46.85 74.9 50 70.4Q53.15 74.9 57.5 70.6");
}

#[test]
fn bodies_default_to_the_retriever_and_shapes_have_no_breed() {
    assert_eq!(body(None), "dog");
    assert_eq!(body(Some("not a body")), "dog");
    assert_eq!(breed(Some("husky")).map(|breed| breed.name), Some("Husky"));
    assert!(breed(Some("blob")).is_none());
    assert_eq!(dog_color("green"), 0x009957);
    assert_eq!(dog_color("plaid"), dog_color("yellow"));
}

#[test]
fn tones_mix_in_oklab_like_the_stylesheet() {
    assert_eq!(mix(0x377fe6, 1.0, 0x000000), 0x377fe6);
    assert_eq!(mix(0x000000, 0.0, 0xffffff), 0xffffff);
    assert_eq!(tone(0x009957, Tone::Ink), 0x1c1816);
    let lightness = |hex: u32| [16, 8, 0].iter().map(|shift| (hex >> shift) & 0xff).sum::<u32>();
    let green = 0x009957;
    assert!(lightness(tone(green, Tone::Shade)) < lightness(green));
    assert!(lightness(tone(green, Tone::Dark)) < lightness(tone(green, Tone::Shade)));
    assert!(lightness(tone(green, Tone::Light)) > lightness(green));
    assert!(lightness(tone(green, Tone::White)) > lightness(tone(green, Tone::Light)));
}

#[test]
fn the_parser_reads_relative_implicit_and_shorthand_commands() {
    let segments = parse("m10 10 5 0h5v5l-5 5zM0 0Q10 0 10 10T20 20C1 1 2 2 3 3S5 5 6 6").expect("parses");
    assert_eq!(segments[0], Segment::Move(Point::new(10.0, 10.0)));
    assert_eq!(segments[1], Segment::Line(Point::new(15.0, 10.0)));
    assert_eq!(segments[2], Segment::Line(Point::new(20.0, 10.0)));
    assert_eq!(segments[3], Segment::Line(Point::new(20.0, 15.0)));
    assert_eq!(segments[4], Segment::Line(Point::new(15.0, 20.0)));
    assert_eq!(segments[5], Segment::Close);
    let Segment::Cubic(_, _, end) = segments[7] else { panic!("a quadratic becomes a cubic") };
    assert_eq!(end, Point::new(10.0, 10.0));
    let Segment::Cubic(first, _, end) = segments[8] else { panic!("a smooth quadratic becomes a cubic") };
    assert_eq!(end, Point::new(20.0, 20.0));
    assert!((first.x - 10.0).abs() < 1e-9 && (first.y - (10.0 + 20.0 / 3.0)).abs() < 1e-9);
    let Segment::Cubic(first, _, _) = segments[10] else { panic!("a smooth cubic") };
    assert_eq!(first, Point::new(4.0, 4.0));
}

#[test]
fn arcs_land_on_their_end_point_and_bulge_the_right_way() {
    let segments = parse("M0 50A50 50 0 0 1 100 50").expect("parses");
    let Some(Segment::Cubic(_, _, end)) = segments.last() else { panic!("an arc becomes cubics") };
    assert_eq!(*end, Point::new(100.0, 50.0));
    let (low, _) = bounds(&segments).expect("points");
    assert!(low.y < 5.0, "a clockwise half circle from left to right bulges up: {low:?}");
    let circle = parse("M43.5 9.5A6.5 6.5 0 1 0 56.5 9.5A6.5 6.5 0 1 0 43.5 9.5Z").expect("parses");
    let (low, high) = bounds(&circle).expect("points");
    assert!((low.x - 43.5).abs() < 0.2 && (high.x - 56.5).abs() < 0.2 && (low.y - 3.0).abs() < 0.6 && (high.y - 16.0).abs() < 0.6, "{low:?} {high:?}");
}

#[test]
fn broken_path_data_is_an_error_not_a_panic() {
    assert!(parse("").is_err());
    assert!(parse("L1 2").is_err());
    assert!(parse("M1").is_err());
    assert!(parse("M1 2 X3 4").is_err());
    assert!(parse("M1 2A1 1 0 2 0 3 3").is_err());
}
