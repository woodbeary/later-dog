mod engines;
mod memory;
mod policy;
mod server;
mod shell;

use engines::{Config, Pool};
use policy::Limits;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;

fn number(name: &str, fallback: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(fallback)
}

fn config() -> Config {
    Config {
        root: PathBuf::from(std::env::var("LATERDOG_POOL_ROOT").unwrap_or_else(|_| "/pool".into())),
        engine_root: std::env::var("LATERDOG_POOL_ENGINE_ROOT").unwrap_or_else(|_| "/home/dog/.laterdog-engine/cli/".into()),
        shell_dir: PathBuf::from(std::env::var("LATERDOG_POOL_SHELL_DIR").unwrap_or_else(|_| "/usr/local/lib/laterdog-pool/bin".into())),
        limits: Limits {
            budget_percent: number("LATERDOG_POOL_BUDGET_PERCENT", 75).clamp(10, 95),
            idle_ms: number("LATERDOG_POOL_IDLE_SECONDS", 600).max(10) * 1000,
            estimate_floor: number("LATERDOG_POOL_ENGINE_ESTIMATE_MB", 300) * MIB,
        },
        scratch_bytes: number("LATERDOG_POOL_SCRATCH_MB", 512) * MIB,
        command_seconds: number("LATERDOG_POOL_COMMAND_SECONDS", 60),
        command_bytes: number("LATERDOG_POOL_COMMAND_MB", 512) * MIB,
        max_engines: number("LATERDOG_POOL_MAX_ENGINES", 40).clamp(1, 500) as u32,
        buffer_bytes: (number("LATERDOG_POOL_BUFFER_KB", 1024) * 1024) as usize,
    }
}

fn serve() {
    let config = config();
    engines::prepare_host(&config);
    let port = number("LATERDOG_POOL_PORT", 7171) as u16;
    let shared = Arc::new(Mutex::new(Pool::new(config)));
    let sweeper = shared.clone();
    thread::spawn(move || {
        let mut round = 1u64;
        loop {
            thread::sleep(Duration::from_secs(1));
            engines::sweep(&sweeper, round);
            round += 1;
        }
    });
    server::listen(shared, port);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let invoked = args.first().map(|first| Path::new(first).file_name().unwrap_or_default().to_string_lossy().to_string()).unwrap_or_default();
    if invoked == "bash" {
        std::process::exit(shell::run(&args[1..]));
    }
    match args.get(1).map(String::as_str) {
        Some("serve") => serve(),
        Some("shell") => std::process::exit(shell::run(&args[2..])),
        _ => {
            eprintln!("usage: laterdog-pool-agent serve");
            std::process::exit(2);
        }
    }
}
