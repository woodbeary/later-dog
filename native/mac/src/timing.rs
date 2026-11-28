use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static START: OnceLock<Instant> = OnceLock::new();
static ON: OnceLock<bool> = OnceLock::new();

pub fn start() {
    START.get_or_init(Instant::now);
    let on = *ON.get_or_init(|| std::env::var("LATERDOG_TIMING").is_ok_and(|value| value == "1"));
    if on {
        let wall = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |since| since.as_secs_f64());
        eprintln!("timing main {wall:.3}");
    }
}

pub fn mark(label: &str) {
    if !ON.get().copied().unwrap_or(false) {
        return;
    }
    let elapsed = START.get().map_or(0.0, |start| start.elapsed().as_secs_f64() * 1000.0);
    eprintln!("timing {elapsed:8.1} ms {label}");
}
