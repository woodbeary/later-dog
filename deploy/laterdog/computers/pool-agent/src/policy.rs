#[derive(Clone, Debug, PartialEq)]
pub struct EngineLoad {
    pub chat: String,
    pub attached: bool,
    pub last_used_ms: u64,
    pub memory: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HostLoad {
    pub limit: u64,
    pub used: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub budget_percent: u64,
    pub idle_ms: u64,
    pub estimate_floor: u64,
}

pub fn budget(host: HostLoad, limits: Limits) -> u64 {
    host.limit / 100 * limits.budget_percent
}

pub fn idle_out(engines: &[EngineLoad], now_ms: u64, limits: Limits) -> Vec<String> {
    engines
        .iter()
        .filter(|engine| !engine.attached && now_ms.saturating_sub(engine.last_used_ms) >= limits.idle_ms)
        .map(|engine| engine.chat.clone())
        .collect()
}

fn least_recent_first(engines: &[EngineLoad]) -> Vec<&EngineLoad> {
    let mut idle: Vec<&EngineLoad> = engines.iter().filter(|engine| !engine.attached).collect();
    idle.sort_by(|a, b| a.last_used_ms.cmp(&b.last_used_ms).then_with(|| a.chat.cmp(&b.chat)));
    idle
}

pub fn relieve(engines: &[EngineLoad], host: HostLoad, limits: Limits) -> Vec<String> {
    let ceiling = budget(host, limits);
    let mut used = host.used;
    let mut chosen = Vec::new();
    for engine in least_recent_first(engines) {
        if used <= ceiling {
            break;
        }
        used = used.saturating_sub(engine.memory);
        chosen.push(engine.chat.clone());
    }
    chosen
}

pub fn estimate(engines: &[EngineLoad], limits: Limits) -> u64 {
    if engines.is_empty() {
        return limits.estimate_floor;
    }
    let total: u64 = engines.iter().map(|engine| engine.memory).sum();
    (total / engines.len() as u64).max(limits.estimate_floor)
}

pub fn make_room(engines: &[EngineLoad], host: HostLoad, need: u64, limits: Limits) -> Option<Vec<String>> {
    let ceiling = budget(host, limits);
    let mut used = host.used;
    let mut chosen = Vec::new();
    if used + need <= ceiling {
        return Some(chosen);
    }
    for engine in least_recent_first(engines) {
        used = used.saturating_sub(engine.memory);
        chosen.push(engine.chat.clone());
        if used + need <= ceiling {
            return Some(chosen);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;
    const LIMITS: Limits = Limits { budget_percent: 75, idle_ms: 600_000, estimate_floor: 300 * MIB };

    fn engine(chat: &str, attached: bool, last_used_ms: u64, memory_mib: u64) -> EngineLoad {
        EngineLoad { chat: chat.into(), attached, last_used_ms, memory: memory_mib * MIB }
    }

    fn host(limit_mib: u64, used_mib: u64) -> HostLoad {
        HostLoad { limit: limit_mib * MIB, used: used_mib * MIB }
    }

    #[test]
    fn idles_out_detached_engines_after_ten_minutes_but_never_an_attached_one() {
        let engines = [engine("a", false, 0, 300), engine("b", true, 0, 300), engine("c", false, 500_000, 300)];
        assert_eq!(idle_out(&engines, 600_000, LIMITS), vec!["a".to_string()]);
        assert_eq!(idle_out(&engines, 1_100_000, LIMITS), vec!["a".to_string(), "c".to_string()]);
    }

    #[test]
    fn relieves_pressure_least_recently_used_first_and_stops_under_budget() {
        let engines = [engine("old", false, 10, 400), engine("busy", true, 0, 900), engine("mid", false, 20, 400), engine("new", false, 30, 400)];
        assert_eq!(relieve(&engines, host(4000, 3500), LIMITS), vec!["old".to_string(), "mid".to_string()]);
        assert!(relieve(&engines, host(4000, 2900), LIMITS).is_empty());
    }

    #[test]
    fn makes_room_by_evicting_idle_engines_or_says_the_host_is_full() {
        let engines = [engine("idle", false, 5, 500), engine("busy", true, 1, 2000)];
        assert_eq!(make_room(&engines, host(4000, 2000), 300 * MIB, LIMITS), Some(vec![]));
        assert_eq!(make_room(&engines, host(4000, 2700), 400 * MIB, LIMITS), Some(vec!["idle".to_string()]));
        assert_eq!(make_room(&engines, host(4000, 2900), 900 * MIB, LIMITS), None);
    }

    #[test]
    fn estimates_from_the_mean_warm_engine_with_a_floor() {
        assert_eq!(estimate(&[], LIMITS), 300 * MIB);
        assert_eq!(estimate(&[engine("a", false, 0, 200), engine("b", false, 0, 600)], LIMITS), 400 * MIB);
        assert_eq!(estimate(&[engine("a", false, 0, 100)], LIMITS), 300 * MIB);
    }
}
