use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::env;
use std::fs;
use std::io::{self, BufRead, BufWriter, Write};

const ALL_ROWS: &str = "SELECT json FROM messages WHERE thread_id = ?1 ORDER BY rowid";
const NEWEST_ROWS: &str = "SELECT json FROM messages WHERE thread_id = ?1 ORDER BY rowid DESC LIMIT ?2";
const ACTIVE_LEAF: &str = "SELECT active_leaf_id FROM thread_state WHERE thread_id = ?1";

fn quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if (other as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", other as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn rows(connection: &Connection, thread: &str, limit: usize) -> rusqlite::Result<(Vec<String>, bool)> {
    if limit == 0 {
        let mut statement = connection.prepare_cached(ALL_ROWS)?;
        let found = statement.query_map([thread], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        return Ok((found, false));
    }
    let mut statement = connection.prepare_cached(NEWEST_ROWS)?;
    let mut found = statement
        .query_map(rusqlite::params![thread, (limit + 1) as i64], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    let more = found.len() > limit;
    found.truncate(limit);
    found.reverse();
    Ok((found, more))
}

fn opened(connection: &Connection, thread: &str, limit: usize) -> rusqlite::Result<String> {
    let (messages, more) = rows(connection, thread, limit)?;
    let leaf: Option<String> = connection
        .prepare_cached(ACTIVE_LEAF)?
        .query_row([thread], |row| row.get::<_, Option<String>>(0))
        .optional()?
        .flatten();
    let size: usize = messages.iter().map(|message| message.len() + 1).sum();
    let mut out = String::with_capacity(size + 96);
    out.push_str("{\"messages\":[");
    for (index, message) in messages.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(message);
    }
    out.push_str("],\"activeLeafId\":");
    match leaf {
        Some(id) => out.push_str(&quoted(&id)),
        None => out.push_str("null"),
    }
    out.push_str(if more { ",\"hasMore\":true}" } else { ",\"hasMore\":false}" });
    Ok(out)
}

fn peak_rss_kb() -> u64 {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("VmHWM:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|kilobytes| kilobytes.parse::<u64>().ok())
        })
        .unwrap_or(0)
}

fn main() {
    let arguments: Vec<String> = env::args().collect();
    let usage = "chat-open <once|serve> <messages.db> [thread] [limit]";
    let mode = arguments.get(1).expect(usage).as_str();
    let connection = Connection::open_with_flags(arguments.get(2).expect(usage), OpenFlags::SQLITE_OPEN_READ_ONLY).expect("database");
    let mut out = BufWriter::new(io::stdout().lock());
    if mode == "once" {
        let limit: usize = arguments.get(4).and_then(|value| value.parse().ok()).unwrap_or(0);
        let answer = opened(&connection, arguments.get(3).expect(usage), limit).expect("thread rows");
        out.write_all(answer.as_bytes()).expect("answer");
        out.flush().expect("answer");
        return;
    }
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let answer = match line.split_once(' ') {
            Some((limit, thread)) => opened(&connection, thread, limit.parse().unwrap_or(0)).expect("thread rows"),
            None => format!("{{\"peakRssKb\":{}}}", peak_rss_kb()),
        };
        out.write_all(answer.as_bytes()).expect("answer");
        out.write_all(b"\n").expect("answer");
        out.flush().expect("answer");
    }
}
