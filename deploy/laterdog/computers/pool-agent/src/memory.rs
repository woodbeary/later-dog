use crate::policy::HostLoad;
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

const PAGE: u64 = 4096;

pub fn kib_field(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let rest = line.strip_prefix(name)?.strip_prefix(':')?;
        rest.split_whitespace().next()?.parse::<u64>().ok().map(|kib| kib * 1024)
    })
}

pub fn real_uid(status: &str) -> Option<u32> {
    status.lines().find_map(|line| line.strip_prefix("Uid:")?.split_whitespace().next()?.parse().ok())
}

pub fn stat_group(stat: &str) -> Option<i32> {
    let after = &stat[stat.rfind(')')? + 1..];
    after.split_whitespace().nth(2)?.parse().ok()
}

pub fn cgroup_load(max: &str, current: &str, stat: &str, total: u64) -> Option<HostLoad> {
    let current: u64 = current.trim().parse().ok()?;
    let limit = match max.trim() {
        "max" => total,
        value => value.parse().ok()?,
    };
    let inactive = stat
        .lines()
        .find_map(|line| line.strip_prefix("inactive_file ")?.trim().parse::<u64>().ok())
        .unwrap_or(0);
    Some(HostLoad { limit: limit.min(total.max(1)), used: current.saturating_sub(inactive) })
}

pub fn meminfo_load(meminfo: &str) -> Option<HostLoad> {
    let total = kib_field(meminfo, "MemTotal")?;
    let available = kib_field(meminfo, "MemAvailable")?;
    Some(HostLoad { limit: total, used: total.saturating_sub(available) })
}

pub fn host() -> HostLoad {
    let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let fallback = meminfo_load(&meminfo).unwrap_or(HostLoad { limit: 1, used: 0 });
    let read = |name: &str| fs::read_to_string(format!("/sys/fs/cgroup/{name}"));
    let cgroup = match (read("memory.max"), read("memory.current"), read("memory.stat")) {
        (Ok(max), Ok(current), Ok(stat)) => cgroup_load(&max, &current, &stat, fallback.limit),
        _ => None,
    };
    widest(fallback, cgroup)
}

pub fn widest(machine: HostLoad, cgroup: Option<HostLoad>) -> HostLoad {
    match cgroup {
        Some(group) => HostLoad { limit: group.limit.min(machine.limit), used: group.used.max(machine.used) },
        None => machine,
    }
}

fn pids() -> Vec<i32> {
    let Ok(entries) = fs::read_dir("/proc") else { return Vec::new() };
    entries.filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok()).collect()
}

fn resident(pid: i32) -> u64 {
    if let Some(pss) = fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok().and_then(|text| kib_field(&text, "Pss")) {
        return pss;
    }
    fs::read_to_string(format!("/proc/{pid}/statm"))
        .ok()
        .and_then(|text| text.split_whitespace().nth(1)?.parse::<u64>().ok())
        .map_or(0, |pages| pages * PAGE)
}

pub fn self_resident() -> u64 {
    resident(std::process::id() as i32)
}

pub struct UidUse {
    pub bytes: u64,
    pub pids: Vec<i32>,
}

pub fn by_uid() -> HashMap<u32, UidUse> {
    let mut found: HashMap<u32, UidUse> = HashMap::new();
    for pid in pids() {
        let Some(uid) = fs::read_to_string(format!("/proc/{pid}/status")).ok().as_deref().and_then(real_uid) else { continue };
        let entry = found.entry(uid).or_insert(UidUse { bytes: 0, pids: Vec::new() });
        entry.bytes += resident(pid);
        entry.pids.push(pid);
    }
    found
}

pub fn group_bytes(group: i32) -> u64 {
    pids()
        .into_iter()
        .filter(|pid| fs::read_to_string(format!("/proc/{pid}/stat")).ok().as_deref().and_then(stat_group) == Some(group))
        .map(resident)
        .sum()
}

pub fn cpu_count(cpu_max: &str) -> Option<f64> {
    let mut parts = cpu_max.split_whitespace();
    let quota: f64 = parts.next()?.parse().ok()?;
    let period: f64 = parts.next()?.parse().ok()?;
    (period > 0.0).then_some(quota / period)
}

pub fn cpu_usec(stat: &str) -> Option<u64> {
    stat.lines().find_map(|line| line.strip_prefix("usage_usec ")?.trim().parse().ok())
}

pub fn cpu() -> (u64, f64) {
    let used = fs::read_to_string("/sys/fs/cgroup/cpu.stat").ok().as_deref().and_then(cpu_usec).unwrap_or(0);
    let cpus = fs::read_to_string("/sys/fs/cgroup/cpu.max")
        .ok()
        .as_deref()
        .and_then(cpu_count)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1.0, |count| count.get() as f64));
    (used, cpus)
}

pub fn dir_bytes(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 0 };
    let own = meta.blocks() * 512;
    if !meta.is_dir() {
        return own;
    }
    let Ok(entries) = fs::read_dir(path) else { return own };
    own + entries.filter_map(Result::ok).map(|entry| dir_bytes(&entry.path())).sum::<u64>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_proportional_memory_and_the_real_uid() {
        assert_eq!(kib_field("Rss:  2048 kB\nPss:   1024 kB\n", "Pss"), Some(1024 * 1024));
        assert_eq!(kib_field("Pss_Anon: 7 kB\n", "Pss"), None);
        assert_eq!(real_uid("Name:\tengine\nUid:\t20001\t20001\t20001\t20001\n"), Some(20001));
    }

    #[test]
    fn reads_the_process_group_past_a_name_with_spaces() {
        assert_eq!(stat_group("42 (my (odd) name) S 1 42 42 0 -1"), Some(42));
    }

    #[test]
    fn counts_the_cgroup_working_set_without_reclaimable_cache() {
        let load = cgroup_load("12884901888\n", "4000000000\n", "anon 1\ninactive_file 1000000000\n", 16_000_000_000).unwrap();
        assert_eq!(load, HostLoad { limit: 12_884_901_888, used: 3_000_000_000 });
        assert_eq!(cgroup_load("max\n", "100\n", "", 5000).unwrap().limit, 5000);
        let machine = HostLoad { limit: 8_000, used: 900 };
        assert_eq!(widest(machine, Some(HostLoad { limit: 8_000, used: 3 })), machine);
        assert_eq!(widest(machine, Some(HostLoad { limit: 4_000, used: 2_000 })), HostLoad { limit: 4_000, used: 2_000 });
        assert_eq!(cpu_count("200000 100000\n"), Some(2.0));
        let machine = HostLoad { limit: 8_000, used: 900 };
        assert_eq!(widest(machine, Some(HostLoad { limit: 8_000, used: 3 })), machine);
        assert_eq!(widest(machine, Some(HostLoad { limit: 4_000, used: 2_000 })), HostLoad { limit: 4_000, used: 2_000 });
        assert_eq!(cpu_count("max 100000\n"), None);
        assert_eq!(cpu_usec("usage_usec 1500\nuser_usec 1\n"), Some(1500));
        assert_eq!(meminfo_load("MemTotal: 1000 kB\nMemFree: 1 kB\nMemAvailable: 400 kB\n"), Some(HostLoad { limit: 1024000, used: 614400 }));
    }
}
