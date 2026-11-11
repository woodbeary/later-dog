use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;
use std::time::Instant;

const CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const SKIPPED_NAMES: [&str; 14] = [
    "node_modules",
    ".cache",
    ".tmp",
    ".npm",
    ".pnpm-store",
    "Cache",
    "Code Cache",
    "GPUCache",
    "ShaderCache",
    "Crashpad",
    ".Trash",
    "lost+found",
    ".oauth_refresh.lock",
    ".oauth_refresh.lock.owner",
];
const SKIPPED_SUFFIXES: [&str; 3] = ["-wal", "-shm", "-journal"];
const SKIPPED_PATHS: [&str; 1] = [".local/share/pnpm"];
const RESTORING_PREFIX: &str = ".laterdog-restoring-";
const DATABASE_SUFFIXES: [&str; 3] = [".sqlite", ".sqlite3", ".db"];

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    path: String,
    mode: u32,
    #[serde(rename = "mtimeMs")]
    mtime_ms: i64,
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunks: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Manifest {
    entries: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    mode: String,
    threads: usize,
    entries: usize,
    changed: usize,
    chunks: usize,
    bytes_hashed: u64,
    scan_ms: f64,
    compare_ms: f64,
    hash_ms: f64,
    total_ms: f64,
    peak_rss_mb: f64,
}

fn skipped(name: &str) -> bool {
    SKIPPED_NAMES.contains(&name)
        || name.starts_with(RESTORING_PREFIX)
        || SKIPPED_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

fn skipped_path(path: &str) -> bool {
    SKIPPED_PATHS
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
}

fn mtime_ms(info: &fs::Metadata) -> i64 {
    info.mtime() * 1000 + info.mtime_nsec() / 1_000_000
}

fn walk(root: &Path, directory: &Path, found: &mut Vec<Entry>) {
    let Ok(listing) = fs::read_dir(directory) else {
        return;
    };
    let mut names: Vec<String> = listing
        .filter_map(|item| item.ok())
        .filter_map(|item| item.file_name().into_string().ok())
        .collect();
    names.sort();
    for name in names {
        if skipped(&name) {
            continue;
        }
        let path = directory.join(&name);
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().into_owned();
        if skipped_path(&relative) {
            continue;
        }
        let Ok(info) = fs::symlink_metadata(&path) else {
            continue;
        };
        let entry = Entry {
            path: relative,
            mode: info.mode() & 0o7777,
            mtime_ms: mtime_ms(&info),
            kind: String::new(),
            size: None,
            target: None,
            stamp: None,
            chunks: None,
        };
        let kind = info.file_type();
        if kind.is_dir() {
            if name.ends_with(".lock") {
                continue;
            }
            found.push(Entry { kind: "dir".into(), ..entry });
            walk(root, &path, found);
        } else if kind.is_symlink() {
            let target = fs::read_link(&path)
                .map(|target| target.to_string_lossy().into_owned())
                .unwrap_or_default();
            found.push(Entry { kind: "link".into(), target: Some(target), ..entry });
        } else if kind.is_file() {
            found.push(Entry { kind: "file".into(), size: Some(info.size()), ..entry });
        }
    }
}

fn database(path: &str) -> bool {
    DATABASE_SUFFIXES.iter().any(|suffix| path.ends_with(suffix))
}

fn database_stamp(root: &Path, entry: &Entry) -> String {
    let wal = fs::symlink_metadata(root.join(format!("{}-wal", entry.path))).ok();
    format!(
        "{}:{}:{}:{}",
        entry.size.unwrap_or(0),
        entry.mtime_ms,
        wal.as_ref().map(|info| info.size()).unwrap_or(0),
        wal.as_ref().map(mtime_ms).unwrap_or(0)
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn chunk_hash(file: &File, index: u64, size: u64) -> String {
    let start = index * CHUNK_BYTES;
    let length = (size - start).min(CHUNK_BYTES) as usize;
    let mut buffer = vec![0u8; length];
    let mut filled = 0;
    while filled < length {
        match file.read_at(&mut buffer[filled..], start + filled as u64) {
            Ok(0) | Err(_) => break,
            Ok(read) => filled += read,
        }
    }
    hex(&Sha256::digest(&buffer[..filled]))
}

fn chunks_of(root: &Path, entry: &Entry, parallel: bool) -> Vec<String> {
    let Ok(file) = File::open(root.join(&entry.path)) else {
        return Vec::new();
    };
    let size = entry.size.unwrap_or(0);
    let count = size.div_ceil(CHUNK_BYTES);
    if parallel {
        (0..count).into_par_iter().map(|index| chunk_hash(&file, index, size)).collect()
    } else {
        (0..count).map(|index| chunk_hash(&file, index, size)).collect()
    }
}

fn peak_rss_mb() -> f64 {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("VmHWM:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|kilobytes| kilobytes.parse::<f64>().ok())
        })
        .map(|kilobytes| kilobytes / 1024.0)
        .unwrap_or(0.0)
}

fn milliseconds(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let arguments: Vec<String> = env::args().collect();
    let mode = arguments.get(1).cloned().unwrap_or_default();
    let root = Path::new(arguments.get(2).expect("save-walk <scan|scan-json|save> <root> [previous.json] [threads]"));
    let threads: usize = arguments.get(4).and_then(|value| value.parse().ok()).unwrap_or(1);
    rayon::ThreadPoolBuilder::new().num_threads(threads).build_global().expect("thread pool");
    let started = Instant::now();
    let mut scanned = Vec::new();
    walk(root, root, &mut scanned);
    let scan_ms = milliseconds(started);
    if mode == "scan-json" {
        let mut out = BufWriter::new(io::stdout().lock());
        serde_json::to_writer(&mut out, &scanned).expect("entries");
        out.flush().expect("entries");
        return;
    }
    let mut report = Report {
        mode: mode.clone(),
        threads,
        entries: scanned.len(),
        changed: 0,
        chunks: 0,
        bytes_hashed: 0,
        scan_ms,
        compare_ms: 0.0,
        hash_ms: 0.0,
        total_ms: 0.0,
        peak_rss_mb: 0.0,
    };
    if mode == "save" {
        let comparing = Instant::now();
        let previous: Manifest = serde_json::from_str(&fs::read_to_string(&arguments[3]).expect("previous manifest")).expect("manifest json");
        let known: HashMap<&str, &Entry> = previous
            .entries
            .iter()
            .filter(|entry| entry.kind == "file")
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        let mut waiting = Vec::new();
        for entry in scanned.iter_mut().filter(|entry| entry.kind == "file") {
            if database(&entry.path) {
                entry.stamp = Some(database_stamp(root, entry));
            }
            let unchanged = known
                .get(entry.path.as_str())
                .is_some_and(|before| before.size == entry.size && before.mtime_ms == entry.mtime_ms && before.stamp == entry.stamp);
            if !unchanged {
                waiting.push(entry.clone());
            }
        }
        report.compare_ms = milliseconds(comparing);
        let hashing = Instant::now();
        let parallel = threads > 1;
        let hashed: Vec<Vec<String>> = if parallel {
            waiting.par_iter().map(|entry| chunks_of(root, entry, true)).collect()
        } else {
            waiting.iter().map(|entry| chunks_of(root, entry, false)).collect()
        };
        report.hash_ms = milliseconds(hashing);
        report.changed = waiting.len();
        report.chunks = hashed.iter().map(Vec::len).sum();
        report.bytes_hashed = waiting.iter().filter_map(|entry| entry.size).sum();
    }
    report.total_ms = milliseconds(started);
    report.peak_rss_mb = peak_rss_mb();
    println!("{}", serde_json::to_string(&report).expect("report"));
}
