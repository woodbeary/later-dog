mod net;
mod ui;

use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

use crate::net::Home;
use crate::ui::{Controller, Options, SendRequest};

fn options() -> Options {
    let mut args = std::env::args().skip(1);
    let mut dump = std::env::var("LATERDOG_DUMP").is_ok_and(|value| value == "1");
    let mut text = None;
    let mut to = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dump" => dump = true,
            "--send" => text = args.next(),
            "--to" => to = args.next(),
            _ => {}
        }
    }
    Options { dump, send: text.map(|text| SendRequest { text, to }) }
}

fn seed() -> [u8; 16] {
    let mut seed = [0u8; 16];
    let read = std::fs::File::open("/dev/urandom").and_then(|mut source| source.read_exact(&mut seed));
    if read.is_err() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_nanos());
        seed = (nanos ^ (u128::from(std::process::id()) << 64)).to_le_bytes();
    }
    seed
}

fn main() {
    let options = options();
    let home_url = std::env::var("LATERDOG_HOME_URL").ok().filter(|url| !url.trim().is_empty());
    let token = std::env::var("LATERDOG_HOME_TOKEN").ok();
    if options.dump && home_url.is_none() {
        eprintln!("Set LATERDOG_HOME_URL to your home's address to connect.");
        std::process::exit(2);
    }

    let mtm = MainThreadMarker::new().expect("the app starts on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.setMainMenu(Some(&ui::menu(mtm)));

    let controller = Controller::new(mtm, options, seed(), home_url.is_some());
    controller.show();
    if let Some(url) = home_url {
        controller.connect(Home::new(url.trim(), token));
    }
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    app.run();
}
