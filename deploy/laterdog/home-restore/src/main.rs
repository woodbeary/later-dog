use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, FileTimes, OpenOptions, Permissions};
use std::io::{self, BufRead, ErrorKind, Read, Write};
use std::os::unix::fs::{fchown, lchown, symlink, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const BUFFER_BYTES: usize = 256 * 1024;
const DEFAULT_PARALLEL: usize = 32;
const MAX_RETRY_MS: u64 = 30_000;
const DEFAULT_RETRY_MS: u64 = 1_000;
const RESTORING_PREFIX: &str = ".laterdog-restoring-";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    #[serde(default)]
    mode: u32,
    #[serde(default)]
    mtime_ms: f64,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    chunks: Vec<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    hardlink: Option<String>,
}

#[derive(Deserialize)]
struct Phase {
    name: String,
    replace: bool,
    #[serde(default)]
    files: Vec<Entry>,
    #[serde(default)]
    links: Vec<Entry>,
    #[serde(default)]
    hardlinks: Vec<Entry>,
}

#[derive(Deserialize, Clone, Copy)]
struct Owner {
    uid: u32,
    gid: u32,
}

#[derive(Deserialize)]
struct Plan {
    root: PathBuf,
    owner: Option<Owner>,
    #[serde(default)]
    dirs: Vec<Entry>,
    phases: Vec<Phase>,
}

enum Failure {
    Retry(String),
    Fatal(String),
}

fn fatal(error: io::Error, doing: &str, path: &str) -> Failure {
    Failure::Fatal(format!("{doing} {path}: {error}"))
}

struct Store {
    agent: ureq::Agent,
    pieces: String,
    authorization: Option<String>,
    host: Option<String>,
}

impl Store {
    fn piece(&self, hash: &str, file: &File, offset: u64, buffer: &mut [u8]) -> Result<u64, Failure> {
        let mut request = self.agent.get(&format!("{}{}", self.pieces, hash));
        if let Some(authorization) = &self.authorization {
            request = request.header("authorization", authorization);
        }
        if let Some(host) = &self.host {
            request = request.header("host", host);
        }
        let response = request.call().map_err(|error| Failure::Retry(error.to_string()))?;
        let mut reader = response.into_body().into_reader();
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        loop {
            let read = reader.read(buffer).map_err(|error| Failure::Retry(error.to_string()))?;
            if read == 0 {
                break;
            }
            if written + read as u64 > CHUNK_BYTES {
                return Err(Failure::Retry(format!("a piece arrived longer than {CHUNK_BYTES} bytes")));
            }
            file.write_all_at(&buffer[..read], offset + written).map_err(|error| fatal(error, "writing", hash))?;
            hasher.update(&buffer[..read]);
            written += read as u64;
        }
        if hex(&hasher.finalize()) != hash {
            return Err(Failure::Retry(format!("a piece arrived damaged ({written} bytes)")));
        }
        Ok(written)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn moment(mtime_ms: f64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(if mtime_ms.is_finite() && mtime_ms > 0.0 { mtime_ms as u64 } else { 0 })
}

fn matches(path: &Path, entry: &Entry) -> bool {
    match fs::symlink_metadata(path) {
        Ok(info) => {
            let millis = info.mtime() * 1000 + (info.mtime_nsec() + 500_000) / 1_000_000;
            info.is_file() && info.len() == entry.size && millis == entry.mtime_ms.trunc() as i64
        }
        Err(_) => false,
    }
}

struct Job {
    phase: usize,
    entry: Entry,
    target: PathBuf,
    staging: PathBuf,
    left: AtomicUsize,
}

struct Piece {
    job: usize,
    index: usize,
    file: Arc<File>,
}

struct Queue {
    pieces: VecDeque<Piece>,
    files: VecDeque<usize>,
    queued: Vec<bool>,
}

struct Engine {
    root: PathBuf,
    owner: Option<Owner>,
    phases: Vec<Phase>,
    jobs: Vec<Job>,
    by_path: HashMap<String, usize>,
    queue: Mutex<Queue>,
    ready: Condvar,
    remaining: Vec<AtomicUsize>,
    settled: Mutex<()>,
    phase_moved: Condvar,
    store: Store,
    retry_ms: u64,
    out: Mutex<io::Stdout>,
    bytes: AtomicU64,
    installed: AtomicUsize,
    kept: AtomicUsize,
    started: Instant,
}

impl Engine {
    fn emit(&self, value: Value) {
        let mut out = self.out.lock().unwrap();
        let _ = writeln!(out, "{value}");
        let _ = out.flush();
    }

    fn own_path(&self, path: &Path) -> io::Result<()> {
        match self.owner {
            Some(owner) => lchown(path, Some(owner.uid), Some(owner.gid)),
            None => Ok(()),
        }
    }

    fn prioritize(&self, paths: &[String]) {
        let mut queue = self.queue.lock().unwrap();
        let mut lifted = std::collections::HashSet::new();
        let wanted: Vec<usize> = paths.iter().filter_map(|path| self.by_path.get(path).copied()).filter(|&job| queue.queued[job] && lifted.insert(job)).collect();
        if wanted.is_empty() {
            return;
        }
        queue.files.retain(|job| !lifted.contains(job));
        for &job in wanted.iter().rev() {
            queue.files.push_front(job);
        }
        self.ready.notify_all();
    }

    fn next(&self) -> Option<Piece> {
        let mut queue = self.queue.lock().unwrap();
        loop {
            if let Some(piece) = queue.pieces.pop_front() {
                return Some(piece);
            }
            if let Some(job) = queue.files.pop_front() {
                if !queue.queued[job] {
                    continue;
                }
                queue.queued[job] = false;
                drop(queue);
                match self.open(job) {
                    Ok(Some(piece)) => return Some(piece),
                    Ok(None) => {
                        queue = self.queue.lock().unwrap();
                        continue;
                    }
                    Err(failure) => self.stop(failure),
                }
            }
            if self.remaining.iter().all(|left| left.load(Ordering::SeqCst) == 0) {
                return None;
            }
            queue = self.ready.wait_timeout(queue, Duration::from_millis(500)).unwrap().0;
        }
    }

    fn open(&self, job_id: usize) -> Result<Option<Piece>, Failure> {
        let job = &self.jobs[job_id];
        if !self.phases[job.phase].replace && fs::symlink_metadata(&job.target).is_ok() {
            self.settle(job_id, "kept");
            return Ok(None);
        }
        let _ = fs::remove_file(&job.staging);
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&job.staging)
            .map_err(|error| fatal(error, "staging", &job.entry.path))?;
        let file = Arc::new(file);
        if job.entry.chunks.is_empty() {
            self.finish(job_id, &file)?;
            return Ok(None);
        }
        let mut queue = self.queue.lock().unwrap();
        for index in (1..job.entry.chunks.len()).rev() {
            queue.pieces.push_front(Piece { job: job_id, index, file: Arc::clone(&file) });
        }
        if job.entry.chunks.len() > 1 {
            self.ready.notify_all();
        }
        Ok(Some(Piece { job: job_id, index: 0, file }))
    }

    fn fetch(&self, piece: &Piece, buffer: &mut [u8]) -> Result<(), Failure> {
        let job = &self.jobs[piece.job];
        let hash = &job.entry.chunks[piece.index];
        let offset = piece.index as u64 * CHUNK_BYTES;
        for attempt in 1u64.. {
            match self.store.piece(hash, &piece.file, offset, buffer) {
                Ok(written) => {
                    self.bytes.fetch_add(written, Ordering::Relaxed);
                    return Ok(());
                }
                Err(Failure::Retry(reason)) => {
                    self.emit(json!({ "retry": job.entry.path, "piece": piece.index, "attempt": attempt, "error": reason }));
                    thread::sleep(Duration::from_millis((attempt * self.retry_ms).min(MAX_RETRY_MS)));
                }
                Err(failure) => return Err(failure),
            }
        }
        unreachable!()
    }

    fn finish(&self, job_id: usize, file: &File) -> Result<(), Failure> {
        let job = &self.jobs[job_id];
        let path = &job.entry.path;
        if let Some(owner) = self.owner {
            fchown(file, Some(owner.uid), Some(owner.gid)).map_err(|error| fatal(error, "owning", path))?;
        }
        file.set_permissions(Permissions::from_mode(job.entry.mode & 0o7777)).map_err(|error| fatal(error, "setting mode of", path))?;
        let time = moment(job.entry.mtime_ms);
        file.set_times(FileTimes::new().set_accessed(time).set_modified(time)).map_err(|error| fatal(error, "dating", path))?;
        if self.phases[job.phase].replace {
            if fs::symlink_metadata(&job.target).map(|info| info.is_dir()).unwrap_or(false) {
                fs::remove_dir_all(&job.target).map_err(|error| fatal(error, "clearing", path))?;
            }
            fs::rename(&job.staging, &job.target).map_err(|error| fatal(error, "placing", path))?;
            self.settle(job_id, "installed");
        } else {
            let placed = fs::hard_link(&job.staging, &job.target);
            let _ = fs::remove_file(&job.staging);
            match placed {
                Ok(()) => self.settle(job_id, "installed"),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    self.settle(job_id, if matches(&job.target, &job.entry) { "installed" } else { "kept" })
                }
                Err(error) => return Err(fatal(error, "placing", path)),
            }
        }
        Ok(())
    }

    fn settle(&self, job_id: usize, how: &str) {
        let job = &self.jobs[job_id];
        if how == "kept" {
            self.kept.fetch_add(1, Ordering::Relaxed);
        } else {
            self.installed.fetch_add(1, Ordering::Relaxed);
        }
        self.emit(json!({ how: job.entry.path }));
        let _guard = self.settled.lock().unwrap();
        self.remaining[job.phase].fetch_sub(1, Ordering::SeqCst);
        self.phase_moved.notify_all();
        self.ready.notify_all();
    }

    fn stop(&self, failure: Failure) -> ! {
        let reason = match failure {
            Failure::Retry(reason) | Failure::Fatal(reason) => reason,
        };
        self.emit(json!({ "error": reason }));
        std::process::exit(1)
    }

    fn work(&self) {
        let mut buffer = vec![0u8; BUFFER_BYTES];
        while let Some(piece) = self.next() {
            if let Err(failure) = self.fetch(&piece, &mut buffer) {
                self.stop(failure);
            }
            let job = &self.jobs[piece.job];
            if job.left.fetch_sub(1, Ordering::SeqCst) == 1 {
                if let Err(failure) = self.finish(piece.job, &piece.file) {
                    self.stop(failure);
                }
            }
        }
    }

    fn links(&self, phase: &Phase) -> Result<(), Failure> {
        for entry in &phase.links {
            let path = self.root.join(&entry.path);
            let target = entry.target.as_deref().unwrap_or_default();
            if phase.replace {
                if let Ok(info) = fs::symlink_metadata(&path) {
                    if info.is_dir() {
                        fs::remove_dir_all(&path).map_err(|error| fatal(error, "clearing", &entry.path))?;
                    } else {
                        fs::remove_file(&path).map_err(|error| fatal(error, "clearing", &entry.path))?;
                    }
                }
            }
            match symlink(target, &path) {
                Ok(()) => {
                    self.own_path(&path).map_err(|error| fatal(error, "owning", &entry.path))?;
                    self.emit(json!({ "installed": entry.path }));
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists && !phase.replace => self.emit(json!({ "kept": entry.path })),
                Err(error) => return Err(fatal(error, "linking", &entry.path)),
            }
        }
        Ok(())
    }

    fn hardlinks(&self, phase: &Phase) -> Result<(), Failure> {
        for entry in &phase.hardlinks {
            let original = self.root.join(entry.hardlink.as_deref().unwrap_or_default());
            let path = self.root.join(&entry.path);
            let info = fs::symlink_metadata(&original).map_err(|error| fatal(error, "reading", &entry.path))?;
            if !info.is_file() || info.len() != entry.size {
                return Err(Failure::Fatal(format!("the hard link target of {} changed", entry.path)));
            }
            let temporary = staging_for(&path, &entry.path);
            let _ = fs::remove_file(&temporary);
            fs::hard_link(&original, &temporary).map_err(|error| fatal(error, "linking", &entry.path))?;
            if fs::symlink_metadata(&path).map(|found| found.is_dir()).unwrap_or(false) {
                fs::remove_dir_all(&path).map_err(|error| fatal(error, "clearing", &entry.path))?;
            }
            let placed = fs::rename(&temporary, &path);
            let _ = fs::remove_file(&temporary);
            placed.map_err(|error| fatal(error, "placing", &entry.path))?;
            self.emit(json!({ "installed": entry.path }));
        }
        Ok(())
    }

    fn dirs(&self, dirs: &[Entry]) -> Result<(), Failure> {
        for entry in dirs {
            let path = self.root.join(&entry.path);
            fs::create_dir_all(&path).map_err(|error| fatal(error, "making", &entry.path))?;
            self.own_path(&path).map_err(|error| fatal(error, "owning", &entry.path))?;
        }
        Ok(())
    }

    fn date_dirs(&self, dirs: &[Entry]) {
        for entry in dirs.iter().rev() {
            let path = self.root.join(&entry.path);
            let _ = fs::set_permissions(&path, Permissions::from_mode(entry.mode & 0o7777));
            if let Ok(handle) = File::open(&path) {
                let time = moment(entry.mtime_ms);
                let _ = handle.set_times(FileTimes::new().set_accessed(time).set_modified(time));
            }
        }
    }

    fn peak_memory() -> u64 {
        fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| status.lines().find(|line| line.starts_with("VmHWM:")).and_then(|line| line.split_whitespace().nth(1)?.parse::<u64>().ok()))
            .map(|kilobytes| kilobytes * 1024)
            .unwrap_or(0)
    }

    fn report(&self, key: &str, name: &str) {
        self.emit(json!({
            key: name,
            "files": self.installed.load(Ordering::Relaxed),
            "kept": self.kept.load(Ordering::Relaxed),
            "bytes": self.bytes.load(Ordering::Relaxed),
            "ms": self.started.elapsed().as_millis() as u64,
            "peakMemoryBytes": Engine::peak_memory(),
        }));
    }
}

fn staging_for(target: &Path, path: &str) -> PathBuf {
    let digest = hex(&Sha256::digest(path.as_bytes()));
    target.parent().unwrap_or(Path::new("/")).join(format!("{RESTORING_PREFIX}{}", &digest[..24]))
}

fn engine(plan: Plan, store: Store, retry_ms: u64) -> Engine {
    let mut jobs = Vec::new();
    let mut by_path = HashMap::new();
    let mut remaining = Vec::new();
    let mut phases = Vec::new();
    for (index, mut phase) in plan.phases.into_iter().enumerate() {
        let files = std::mem::take(&mut phase.files);
        remaining.push(AtomicUsize::new(files.len()));
        for entry in files {
            let target = plan.root.join(&entry.path);
            let staging = staging_for(&target, &entry.path);
            by_path.insert(entry.path.clone(), jobs.len());
            let left = AtomicUsize::new(entry.chunks.len());
            jobs.push(Job { phase: index, entry, target, staging, left });
        }
        phases.push(phase);
    }
    let queue = Queue { pieces: VecDeque::new(), files: (0..jobs.len()).collect(), queued: vec![true; jobs.len()] };
    Engine {
        root: plan.root,
        owner: plan.owner,
        phases,
        jobs,
        by_path,
        queue: Mutex::new(queue),
        ready: Condvar::new(),
        remaining,
        settled: Mutex::new(()),
        phase_moved: Condvar::new(),
        store,
        retry_ms,
        out: Mutex::new(io::stdout()),
        bytes: AtomicU64::new(0),
        installed: AtomicUsize::new(0),
        kept: AtomicUsize::new(0),
        started: Instant::now(),
    }
}

fn store_from_environment(parallel: usize) -> Result<Store, String> {
    let pieces = std::env::var("LATERDOG_RESTORE_PIECES").map_err(|_| "LATERDOG_RESTORE_PIECES is missing".to_string())?;
    let authorization = std::env::var("LATERDOG_RESTORE_TOKEN").ok().filter(|token| !token.is_empty()).map(|token| format!("Bearer {token}"));
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .timeout_connect(Some(Duration::from_secs(10)))
        .max_idle_connections(parallel * 2)
        .max_idle_connections_per_host(parallel * 2)
        .build()
        .into();
    let host = std::env::var("LATERDOG_RESTORE_HOST").ok().filter(|host| !host.is_empty());
    Ok(Store { agent, pieces, authorization, host })
}

fn hold_stop_signals() {
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
    }
}

fn main() {
    hold_stop_signals();
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: laterdog-restore <plan.json>");
        std::process::exit(2)
    });
    let parallel = std::env::var("LATERDOG_RESTORE_PARALLEL").ok().and_then(|value| value.parse().ok()).filter(|&value: &usize| value > 0).unwrap_or(DEFAULT_PARALLEL);
    let plan: Plan = match fs::read(&path).map_err(|error| error.to_string()).and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string())) {
        Ok(plan) => plan,
        Err(error) => {
            println!("{}", json!({ "error": format!("unreadable plan: {error}") }));
            std::process::exit(1)
        }
    };
    let store = match store_from_environment(parallel) {
        Ok(store) => store,
        Err(error) => {
            println!("{}", json!({ "error": error }));
            std::process::exit(1)
        }
    };
    let dirs = plan.dirs.iter().map(|entry| Entry { path: entry.path.clone(), mode: entry.mode, mtime_ms: entry.mtime_ms, size: 0, chunks: Vec::new(), target: None, hardlink: None }).collect::<Vec<_>>();
    let retry_ms = std::env::var("LATERDOG_RESTORE_RETRY_MS").ok().and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_RETRY_MS);
    let engine = Arc::new(engine(plan, store, retry_ms));
    if let Err(failure) = engine.dirs(&dirs) {
        engine.stop(failure);
    }
    for phase in &engine.phases {
        if let Err(failure) = engine.links(phase) {
            engine.stop(failure);
        }
    }
    let listener = Arc::clone(&engine);
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { std::process::exit(1) };
            if let Ok(request) = serde_json::from_str::<Value>(&line) {
                if let Some(paths) = request.get("want").and_then(Value::as_array) {
                    let paths: Vec<String> = paths.iter().filter_map(|path| path.as_str().map(str::to_string)).collect();
                    listener.prioritize(&paths);
                }
            }
        }
        std::process::exit(1)
    });
    let workers: Vec<_> = (0..parallel)
        .map(|_| {
            let worker = Arc::clone(&engine);
            thread::spawn(move || worker.work())
        })
        .collect();
    for (index, phase) in engine.phases.iter().enumerate() {
        let mut guard = engine.settled.lock().unwrap();
        while engine.remaining[index].load(Ordering::SeqCst) > 0 {
            guard = engine.phase_moved.wait(guard).unwrap();
        }
        drop(guard);
        if let Err(failure) = engine.hardlinks(phase) {
            engine.stop(failure);
        }
        engine.report("phase", &phase.name);
    }
    for worker in workers {
        let _ = worker.join();
    }
    engine.date_dirs(&dirs);
    engine.report("finished", "all");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moments_are_whole_milliseconds() {
        assert_eq!(moment(1_700_000_000_123.9).duration_since(UNIX_EPOCH).unwrap().as_millis(), 1_700_000_000_123);
        assert_eq!(moment(-5.0), UNIX_EPOCH);
        assert_eq!(moment(f64::NAN), UNIX_EPOCH);
    }

    #[test]
    fn staging_names_stay_beside_their_file_and_are_skipped_by_saves() {
        let staged = staging_for(Path::new("/data/.laterdog/messages.db"), ".laterdog/messages.db");
        assert_eq!(staged.parent(), Some(Path::new("/data/.laterdog")));
        assert!(staged.file_name().unwrap().to_str().unwrap().starts_with(RESTORING_PREFIX));
    }
}
