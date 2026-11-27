use crate::memory;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

pub const REAL_SHELL: &str = "/bin/bash";
const TICK: Duration = Duration::from_millis(200);

fn env_number(name: &str, fallback: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(fallback)
}

pub fn run(args: &[String]) -> i32 {
    let seconds = env_number("LATERDOG_POOL_COMMAND_SECONDS", 60);
    let bytes = env_number("LATERDOG_POOL_COMMAND_BYTES", 512 * 1024 * 1024);
    let mut child = match Command::new(REAL_SHELL).args(args).process_group(0).spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("laterdog pool: could not start the shell: {error}");
            return 127;
        }
    };
    let group = child.id() as i32;
    let started = Instant::now();
    let mut checks = 0u32;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(9)),
            Ok(None) => {}
            Err(_) => return 1,
        }
        checks += 1;
        let over_time = started.elapsed().as_secs() >= seconds;
        let over_memory = checks % 5 == 0 && memory::group_bytes(group) > bytes;
        if over_time || over_memory {
            unsafe { libc::kill(-group, libc::SIGTERM) };
            sleep(Duration::from_secs(2));
            unsafe { libc::kill(-group, libc::SIGKILL) };
            let _ = child.wait();
            if over_time {
                eprintln!("laterdog pool: the command was stopped after {seconds} seconds, the limit for commands on a chat's scratch folder.");
                return 124;
            }
            eprintln!("laterdog pool: the command was stopped for using more than {} MB of memory.", bytes / 1024 / 1024);
            return 137;
        }
        sleep(TICK);
    }
}
