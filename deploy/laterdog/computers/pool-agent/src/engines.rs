use crate::memory;
use crate::policy::{self, EngineLoad, HostLoad, Limits};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::ffi::CString;
use std::fs;
use std::io::{ErrorKind, Read};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const FIRST_UID: u32 = 20000;
const MAX_ARGS: usize = 64;
const MAX_ENV: usize = 64;
const RESERVED_ENV: [&str; 7] = ["HOME", "PATH", "SHELL", "TMPDIR", "USER", "LOGNAME", "PWD"];
const EVICTIONS_KEPT: usize = 50;

#[derive(Clone)]
pub struct Config {
    pub root: PathBuf,
    pub engine_root: String,
    pub shell_dir: PathBuf,
    pub limits: Limits,
    pub scratch_bytes: u64,
    pub command_seconds: u64,
    pub command_bytes: u64,
    pub max_engines: u32,
    pub buffer_bytes: usize,
}

pub enum Frame {
    Out(u8, Vec<u8>),
    Exit(i32),
    Closed(String),
}

pub type Stdin = Arc<Mutex<Option<ChildStdin>>>;

struct Engine {
    slot: u32,
    pid: u32,
    child: Child,
    stdin: Stdin,
    started_ms: u64,
    start_took_ms: u64,
    last_used_ms: u64,
    attached: Option<(u64, Sender<Frame>)>,
    buffer: VecDeque<u8>,
    dropped: u64,
    memory: u64,
    scratch: u64,
    reuses: u64,
    output_closed: u8,
    exited_ms: Option<u64>,
}

pub struct Pool {
    config: Config,
    engines: HashMap<String, Engine>,
    evictions: VecDeque<Value>,
    host: HostLoad,
    next_attach: u64,
    started: Instant,
    cpu_sample: (Instant, u64),
    cpu_share: f64,
}

pub type Shared = Arc<Mutex<Pool>>;

pub enum OpenError {
    Invalid(String),
    Full(String),
    Failed(String),
}

pub struct Attached {
    pub id: u64,
    pub frames: Receiver<Frame>,
    pub stdin: Stdin,
    pub buffered: Vec<u8>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

pub fn valid_chat(chat: &str) -> bool {
    !chat.is_empty() && chat.len() <= 96 && chat.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.') && !chat.starts_with('.')
}

pub fn valid_command(command: &[String], engine_root: &str) -> Result<(), String> {
    let Some(program) = command.first() else { return Err("command must name the engine to start.".into()) };
    if command.len() > MAX_ARGS || command.iter().any(|arg| arg.contains('\0') || arg.len() > 16 * 1024) {
        return Err(format!("command takes at most {MAX_ARGS} arguments of printable text."));
    }
    let path = Path::new(program);
    let inside = path.starts_with(engine_root) && path.components().all(|part| !matches!(part, Component::ParentDir | Component::CurDir));
    if !inside {
        return Err(format!("command must start an engine installed under {engine_root}."));
    }
    Ok(())
}

pub fn valid_env(env: &[(String, String)]) -> Result<(), String> {
    if env.len() > MAX_ENV {
        return Err(format!("env takes at most {MAX_ENV} entries."));
    }
    for (name, value) in env {
        let well_formed = !name.is_empty()
            && name.bytes().next().is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
            && name.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
        if !well_formed || RESERVED_ENV.contains(&name.as_str()) || name.starts_with("LATERDOG_POOL_") || value.contains('\0') {
            return Err(format!("{name} cannot be set for an engine."));
        }
    }
    Ok(())
}

fn uid_of(slot: u32) -> u32 {
    FIRST_UID + slot
}

impl Pool {
    pub fn new(config: Config) -> Pool {
        Pool { config, engines: HashMap::new(), evictions: VecDeque::new(), host: memory::host(), next_attach: 1, started: Instant::now(), cpu_sample: (Instant::now(), memory::cpu().0), cpu_share: 0.0 }
    }

    fn slot_dir(&self, slot: u32) -> PathBuf {
        self.config.root.join(format!("slot-{slot}"))
    }

    fn loads(&self) -> Vec<EngineLoad> {
        self.engines
            .iter()
            .map(|(chat, engine)| EngineLoad { chat: chat.clone(), attached: engine.attached.is_some(), last_used_ms: engine.last_used_ms, memory: engine.memory })
            .collect()
    }

    fn free_slot(&self) -> Option<u32> {
        (1..=self.config.max_engines).find(|slot| self.engines.values().all(|engine| engine.slot != *slot))
    }

    fn engine_env(&self, slot: u32, extra: &[(String, String)]) -> Vec<(String, String)> {
        let dir = self.slot_dir(slot);
        let shell = self.config.shell_dir.join("bash");
        let mut env: Vec<(String, String)> = vec![
            ("HOME".into(), dir.join("home").display().to_string()),
            ("TMPDIR".into(), dir.join("tmp").display().to_string()),
            ("PATH".into(), format!("{}:/usr/local/bin:/usr/bin:/bin", self.config.shell_dir.display())),
            ("SHELL".into(), shell.display().to_string()),
            ("USER".into(), format!("laterdog-chat-{slot}")),
            ("LOGNAME".into(), format!("laterdog-chat-{slot}")),
            ("LANG".into(), "C.UTF-8".into()),
            ("LATERDOG_POOL_COMMAND_SECONDS".into(), self.config.command_seconds.to_string()),
            ("LATERDOG_POOL_COMMAND_BYTES".into(), self.config.command_bytes.to_string()),
            ("BASH_DEFAULT_TIMEOUT_MS".into(), (self.config.command_seconds * 1000).to_string()),
            ("BASH_MAX_TIMEOUT_MS".into(), (self.config.command_seconds * 1000).to_string()),
            ("PIP_NO_INDEX".into(), "1".into()),
            ("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into()),
            ("npm_config_offline".into(), "true".into()),
            ("npm_config_update_notifier".into(), "false".into()),
        ];
        for (name, value) in extra {
            env.retain(|(existing, _)| existing != name);
            env.push((name.clone(), value.clone()));
        }
        env
    }

    fn prepare_slot(&self, slot: u32) -> Result<PathBuf, String> {
        let uid = uid_of(slot);
        let dir = self.slot_dir(slot);
        let _ = fs::remove_dir_all(&dir);
        for part in ["home", "work", "tmp"] {
            fs::create_dir_all(dir.join(part)).map_err(|error| format!("could not make the scratch folder: {error}"))?;
        }
        if unsafe { libc::geteuid() } == 0 {
            ensure_user(slot)?;
            for path in [dir.clone(), dir.join("home"), dir.join("work"), dir.join("tmp")] {
                let c = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| "bad path".to_string())?;
                unsafe { libc::chown(c.as_ptr(), uid, uid) };
            }
        }
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
        Ok(dir)
    }

    fn spawn(&mut self, shared: &Shared, chat: &str, command: &[String], env: &[(String, String)]) -> Result<(), OpenError> {
        let slot = self.free_slot().ok_or_else(|| OpenError::Full(format!("the host already runs {} engines.", self.config.max_engines)))?;
        let dir = self.prepare_slot(slot).map_err(OpenError::Failed)?;
        let uid = uid_of(slot);
        let as_root = unsafe { libc::geteuid() } == 0;
        let file_limit = self.config.scratch_bytes;
        let began = Instant::now();
        let mut process = Command::new(&command[0]);
        process
            .args(&command[1..])
            .env_clear()
            .envs(self.engine_env(slot, env))
            .current_dir(dir.join("work"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unsafe {
            process.pre_exec(move || {
                libc::setsid();
                #[cfg(target_os = "linux")]
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                let limit = libc::rlimit { rlim_cur: file_limit, rlim_max: file_limit };
                libc::setrlimit(libc::RLIMIT_FSIZE, &limit);
                if as_root && (libc::setgroups(0, std::ptr::null()) != 0 || libc::setgid(uid) != 0 || libc::setuid(uid) != 0) {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = process.spawn().map_err(|error| OpenError::Failed(format!("the engine did not start: {error}")))?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin: Stdin = Arc::new(Mutex::new(child.stdin.take()));
        let now = now_ms();
        self.engines.insert(
            chat.to_string(),
            Engine {
                slot,
                pid,
                child,
                stdin,
                started_ms: now,
                start_took_ms: began.elapsed().as_millis() as u64,
                last_used_ms: now,
                attached: None,
                buffer: VecDeque::new(),
                dropped: 0,
                memory: 0,
                scratch: 0,
                reuses: 0,
                output_closed: 0,
                exited_ms: None,
            },
        );
        if let Some(out) = stdout {
            read_into(shared.clone(), chat.to_string(), pid, 1, out);
        }
        if let Some(err) = stderr {
            read_into(shared.clone(), chat.to_string(), pid, 2, err);
        }
        Ok(())
    }

    pub fn stop(&mut self, chat: &str, reason: &str) {
        let Some(mut engine) = self.engines.remove(chat) else { return };
        kill_uid(uid_of(engine.slot), engine.pid);
        let code = engine.child.wait().ok().and_then(|status| status.code());
        if let Some((_, sink)) = engine.attached.take() {
            let _ = sink.send(if reason == "exited" { Frame::Exit(code.unwrap_or(-1)) } else { Frame::Closed(reason.to_string()) });
        }
        let _ = fs::remove_dir_all(self.slot_dir(engine.slot));
        let now = now_ms();
        self.evictions.push_back(json!({
            "chat": chat,
            "reason": reason,
            "at": now,
            "memoryBytes": engine.memory,
            "warmMs": now.saturating_sub(engine.started_ms),
            "idleMs": now.saturating_sub(engine.last_used_ms),
            "reuses": engine.reuses,
        }));
        while self.evictions.len() > EVICTIONS_KEPT {
            self.evictions.pop_front();
        }
        eprintln!("laterdog pool: closed {chat} ({reason}, {} MB)", engine.memory / 1024 / 1024);
    }

    pub fn status(&self) -> Value {
        let now = now_ms();
        let mut engines: Vec<Value> = self
            .engines
            .iter()
            .map(|(chat, engine)| {
                json!({
                    "chat": chat,
                    "pid": engine.pid,
                    "slot": engine.slot,
                    "attached": engine.attached.is_some(),
                    "startedAt": engine.started_ms,
                    "startMs": engine.start_took_ms,
                    "lastUsedAt": engine.last_used_ms,
                    "idleMs": if engine.attached.is_some() { 0 } else { now.saturating_sub(engine.last_used_ms) },
                    "memoryBytes": engine.memory,
                    "scratchBytes": engine.scratch,
                    "reuses": engine.reuses,
                    "bufferedBytes": engine.buffer.len(),
                    "droppedBytes": engine.dropped,
                })
            })
            .collect();
        engines.sort_by_key(|engine| engine["startedAt"].as_u64());
        let loads = self.loads();
        json!({
            "host": {
                "limitBytes": self.host.limit,
                "usedBytes": self.host.used,
                "budgetBytes": policy::budget(self.host, self.config.limits),
                "estimateBytes": policy::estimate(&loads, self.config.limits),
                "maxEngines": self.config.max_engines,
                "idleMs": self.config.limits.idle_ms,
                "cpuShare": (self.cpu_share * 1000.0).round() / 1000.0,
            },
            "agent": { "residentBytes": memory::self_resident(), "uptimeMs": self.started.elapsed().as_millis() as u64, "version": env!("CARGO_PKG_VERSION") },
            "engines": engines,
            "evictions": self.evictions.iter().cloned().collect::<Vec<Value>>(),
        })
    }

    fn engine_view(&self, chat: &str, warm: bool, evicted: &[String]) -> Value {
        let engine = &self.engines[chat];
        json!({ "chat": chat, "warm": warm, "pid": engine.pid, "slot": engine.slot, "startMs": engine.start_took_ms, "memoryBytes": engine.memory, "reuses": engine.reuses, "evicted": evicted })
    }

    fn refresh_memory(&mut self) {
        let usage = memory::by_uid();
        for engine in self.engines.values_mut() {
            engine.memory = usage.get(&uid_of(engine.slot)).map_or(0, |found| found.bytes);
        }
        self.host = memory::host();
        let (used, cpus) = memory::cpu();
        let (at, before) = self.cpu_sample;
        let elapsed = at.elapsed().as_micros() as f64;
        if elapsed >= 20_000_000.0 {
            self.cpu_share = (used.saturating_sub(before) as f64 / (elapsed * cpus.max(0.01))).clamp(0.0, 1.0);
            self.cpu_sample = (Instant::now(), used);
        }
    }
}

fn ensure_user(slot: u32) -> Result<(), String> {
    let uid = uid_of(slot);
    let passwd = fs::read_to_string("/etc/passwd").unwrap_or_default();
    if passwd.lines().any(|line| line.split(':').nth(2) == Some(&uid.to_string())) {
        return Ok(());
    }
    let name = format!("laterdog-chat-{slot}");
    let status = Command::new("useradd")
        .args(["--uid", &uid.to_string(), "--user-group", "--no-create-home", "--home-dir", &format!("/pool/slot-{slot}/home"), "--shell", "/bin/bash", &name])
        .status()
        .map_err(|error| format!("useradd failed: {error}"))?;
    if status.success() { Ok(()) } else { Err(format!("useradd {name} exited with {status}")) }
}

fn kill_uid(uid: u32, root: u32) {
    unsafe { libc::kill(-(root as i32), libc::SIGKILL) };
    if uid < FIRST_UID {
        return;
    }
    for _ in 0..3 {
        let usage = memory::by_uid();
        let Some(found) = usage.get(&uid) else { return };
        for pid in &found.pids {
            unsafe { libc::kill(*pid, libc::SIGKILL) };
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn read_into(shared: Shared, chat: String, pid: u32, channel: u8, mut source: impl Read + Send + 'static) {
    thread::spawn(move || {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let read = match source.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let mut pool = shared.lock().unwrap();
            let limit = pool.config.buffer_bytes;
            let Some(engine) = pool.engines.get_mut(&chat).filter(|engine| engine.pid == pid) else { break };
            let bytes = &chunk[..read];
            let delivered = engine.attached.as_ref().is_some_and(|(_, sink)| sink.send(Frame::Out(channel, bytes.to_vec())).is_ok());
            if !delivered {
                if engine.attached.take().is_some() {
                    engine.last_used_ms = now_ms();
                }
                if channel == 1 {
                    engine.buffer.extend(bytes);
                    while engine.buffer.len() > limit {
                        engine.buffer.pop_front();
                        engine.dropped += 1;
                    }
                }
            }
        }
        if let Some(engine) = shared.lock().unwrap().engines.get_mut(&chat).filter(|engine| engine.pid == pid) {
            engine.output_closed += 1;
        }
    });
}

pub fn open(shared: &Shared, chat: &str, command: &[String], env: &[(String, String)]) -> Result<(u16, Value), OpenError> {
    if !valid_chat(chat) {
        return Err(OpenError::Invalid("chat must be 1 to 96 letters, digits, dots, dashes or underscores.".into()));
    }
    let mut pool = shared.lock().unwrap();
    if let Some(engine) = pool.engines.get_mut(chat).filter(|engine| engine.exited_ms.is_none()) {
        engine.reuses += 1;
        if engine.attached.is_none() {
            engine.last_used_ms = now_ms();
        }
        return Ok((200, pool.engine_view(chat, true, &[])));
    }
    if pool.engines.contains_key(chat) {
        pool.stop(chat, "exited");
    }
    valid_command(command, &pool.config.engine_root).map_err(OpenError::Invalid)?;
    valid_env(env).map_err(OpenError::Invalid)?;
    pool.host = memory::host();
    let loads = pool.loads();
    let need = policy::estimate(&loads, pool.config.limits);
    let Some(evict) = policy::make_room(&loads, pool.host, need, pool.config.limits) else {
        return Err(OpenError::Full(format!(
            "the host has {} MB in use of a {} MB budget and every warm engine is in a turn.",
            pool.host.used / 1024 / 1024,
            policy::budget(pool.host, pool.config.limits) / 1024 / 1024
        )));
    };
    for other in &evict {
        pool.stop(other, "memory");
    }
    pool.spawn(shared, chat, command, env)?;
    Ok((201, pool.engine_view(chat, false, &evict)))
}

pub fn close(shared: &Shared, chat: &str) -> bool {
    let mut pool = shared.lock().unwrap();
    if !pool.engines.contains_key(chat) {
        return false;
    }
    pool.stop(chat, "closed");
    true
}

pub fn attach(shared: &Shared, chat: &str) -> Option<Attached> {
    let mut pool = shared.lock().unwrap();
    let id = pool.next_attach;
    pool.next_attach += 1;
    let engine = pool.engines.get_mut(chat).filter(|engine| engine.exited_ms.is_none())?;
    let (sink, frames) = channel();
    if let Some((_, previous)) = engine.attached.replace((id, sink)) {
        let _ = previous.send(Frame::Closed("replaced".into()));
    }
    engine.last_used_ms = now_ms();
    let buffered: Vec<u8> = engine.buffer.drain(..).collect();
    Some(Attached { id, frames, stdin: engine.stdin.clone(), buffered })
}

pub fn detach(shared: &Shared, chat: &str, id: u64) {
    let mut pool = shared.lock().unwrap();
    if let Some(engine) = pool.engines.get_mut(chat) {
        if engine.attached.as_ref().is_some_and(|(current, _)| *current == id) {
            engine.attached = None;
            engine.last_used_ms = now_ms();
        }
    }
}

pub fn sweep(shared: &Shared, round: u64) {
    let mut pool = shared.lock().unwrap();
    let now = now_ms();
    let mut finished = Vec::new();
    for (chat, engine) in pool.engines.iter_mut() {
        if engine.exited_ms.is_none() && matches!(engine.child.try_wait(), Ok(Some(_))) {
            engine.exited_ms = Some(now);
        }
        if let Some(at) = engine.exited_ms {
            if engine.output_closed >= 2 || now.saturating_sub(at) > 2000 {
                finished.push(chat.clone());
            }
        }
    }
    for chat in finished {
        pool.stop(&chat, "exited");
    }
    if round % 3 == 0 {
        pool.refresh_memory();
        let limits = pool.config.limits;
        for chat in policy::idle_out(&pool.loads(), now, limits) {
            pool.stop(&chat, "idle");
        }
        for chat in policy::relieve(&pool.loads(), pool.host, limits) {
            pool.stop(&chat, "memory");
        }
    }
    if round % 15 == 0 {
        let over: Vec<String> = {
            let limit = pool.config.scratch_bytes;
            let dirs: Vec<(String, PathBuf)> = pool.engines.iter().map(|(chat, engine)| (chat.clone(), pool.slot_dir(engine.slot))).collect();
            let mut over = Vec::new();
            for (chat, dir) in dirs {
                let bytes = memory::dir_bytes(&dir);
                if let Some(engine) = pool.engines.get_mut(&chat) {
                    engine.scratch = bytes;
                }
                if bytes > limit {
                    over.push(chat);
                }
            }
            over
        };
        for chat in over {
            pool.stop(&chat, "scratch_full");
        }
    }
}

pub fn prepare_host(config: &Config) {
    let _ = fs::create_dir_all(&config.root);
    let _ = fs::set_permissions(&config.root, fs::Permissions::from_mode(0o711));
    if unsafe { libc::geteuid() } != 0 {
        return;
    }
    let mut dir = Path::new(&config.engine_root);
    while let Some(parent) = dir.parent() {
        if dir.as_os_str().len() > 1 {
            if let Ok(meta) = fs::metadata(dir) {
                let mode = meta.permissions().mode() & 0o7777;
                let _ = fs::set_permissions(dir, fs::Permissions::from_mode(mode | 0o011));
            }
        }
        dir = parent;
    }
    let _ = fs::create_dir_all(&config.shell_dir);
    let target = config.shell_dir.join("bash");
    if let Ok(exe) = std::env::current_exe() {
        let _ = fs::remove_file(&target);
        let _ = symlink(exe, &target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_engines_installed_under_the_engine_root() {
        let root = "/home/dog/.laterdog-engine/cli/";
        assert!(valid_command(&["/home/dog/.laterdog-engine/cli/x-1/node_modules/.bin/x".into(), "-p".into()], root).is_ok());
        assert!(valid_command(&["/bin/sh".into()], root).is_err());
        assert!(valid_command(&["/home/dog/.laterdog-engine/cli/../../../bin/sh".into()], root).is_err());
        assert!(valid_command(&[], root).is_err());
    }

    #[test]
    fn keeps_the_scratch_folder_paths_and_limits_out_of_the_callers_reach() {
        assert!(valid_env(&[("API_KEY".into(), "x".into())]).is_ok());
        for name in ["HOME", "PATH", "SHELL", "LATERDOG_POOL_COMMAND_SECONDS", "lower", "1X"] {
            assert!(valid_env(&[(name.into(), "x".into())]).is_err(), "{name}");
        }
    }

    #[test]
    fn names_chats_safely() {
        assert!(valid_chat("dog_abc-123.t1"));
        for bad in ["", ".hidden", "a/b", "a b", &"x".repeat(97)] {
            assert!(!valid_chat(bad), "{bad}");
        }
    }
}
