use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Inline {
    Text { text: String },
    Strong { children: Vec<Inline> },
    Emphasis { children: Vec<Inline> },
    Code { text: String },
    Link { href: Option<String>, children: Vec<Inline> },
    Break,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Block {
    Paragraph { content: Vec<Inline> },
    Heading { level: u8, content: Vec<Inline> },
    Code { language: String, text: String },
    List { ordered: bool, start: u64, items: Vec<Vec<Block>> },
    Quote { blocks: Vec<Block> },
    Table { rows: Vec<Vec<String>> },
    Rule,
}

pub fn text(words: &str) -> Inline {
    Inline::Text { text: words.to_owned() }
}

pub fn parse(source: &str) -> Vec<Block> {
    let lines: Vec<String> = source.replace("\r\n", "\n").replace('\r', "\n").split('\n').map(expand_tabs).collect();
    blocks(&lines)
}

pub fn link_target(raw: &str) -> Option<String> {
    let href = raw.trim();
    if href.is_empty() || href.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let lower = href.to_ascii_lowercase();
    let allowed = ["http://", "https://"].iter().any(|scheme| lower.starts_with(scheme) && lower.len() > scheme.len()) || (lower.starts_with("mailto:") && href.len() > 7);
    allowed.then(|| href.to_owned())
}

pub fn plain(inlines: &[Inline]) -> String {
    let mut out = String::new();
    for inline in inlines {
        match inline {
            Inline::Text { text } | Inline::Code { text } => out.push_str(text),
            Inline::Strong { children } | Inline::Emphasis { children } | Inline::Link { children, .. } => out.push_str(&plain(children)),
            Inline::Break => out.push('\n'),
        }
    }
    out
}

pub fn table_text(rows: &[Vec<String>]) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns).map(|column| rows.iter().filter_map(|row| row.get(column)).map(|cell| cell.chars().count()).max().unwrap_or(0).max(3)).collect();
    let line = |cells: Vec<String>| -> String {
        let padded: Vec<String> = cells.iter().enumerate().map(|(column, cell)| format!("{cell:<width$}", width = widths[column])).collect();
        padded.join("  ").trim_end().to_owned()
    };
    let mut out = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        out.push(line((0..columns).map(|column| row.get(column).cloned().unwrap_or_default()).collect()));
        if index == 0 {
            out.push(line(widths.iter().map(|width| "-".repeat(*width)).collect()));
        }
    }
    out.join("\n")
}

const LANGUAGES: [(&str, &str); 66] = [("js", "JavaScript"), ("javascript", "JavaScript"), ("jsx", "JavaScript (JSX)"), ("ts", "TypeScript"), ("typescript", "TypeScript"), ("tsx", "TypeScript (TSX)"), ("node", "Node.js"), ("html", "HTML"), ("htm", "HTML"), ("css", "CSS"), ("scss", "SCSS"), ("sass", "Sass"), ("less", "Less"), ("json", "JSON"), ("jsonc", "JSON"), ("json5", "JSON5"), ("xml", "XML"), ("svg", "SVG"), ("md", "Markdown"), ("markdown", "Markdown"), ("mdx", "MDX"), ("yaml", "YAML"), ("yml", "YAML"), ("toml", "TOML"), ("sh", "Bash"), ("bash", "Bash"), ("zsh", "Bash"), ("shell", "Shell"), ("ps1", "PowerShell"), ("powershell", "PowerShell"), ("fish", "Fish"), ("c", "C"), ("cpp", "C++"), ("c++", "C++"), ("cc", "C++"), ("cxx", "C++"), ("cs", "C#"), ("csharp", "C#"), ("c#", "C#"), ("rs", "Rust"), ("rust", "Rust"), ("go", "Go"), ("golang", "Go"), ("py", "Python"), ("python", "Python"), ("rb", "Ruby"), ("ruby", "Ruby"), ("php", "PHP"), ("java", "Java"), ("kt", "Kotlin"), ("kotlin", "Kotlin"), ("swift", "Swift"), ("dart", "Dart"), ("r", "R"), ("lua", "Lua"), ("sql", "SQL"), ("graphql", "GraphQL"), ("gql", "GraphQL"), ("proto", "Protobuf"), ("protobuf", "Protobuf"), ("docker", "Dockerfile"), ("dockerfile", "Dockerfile"), ("makefile", "Makefile"), ("make", "Makefile"), ("diff", "Diff"), ("wasm", "WebAssembly")];

const EXTENSIONS: [(&str, &str); 66] = [("js", "js"), ("javascript", "js"), ("jsx", "jsx"), ("ts", "ts"), ("typescript", "ts"), ("tsx", "tsx"), ("node", "js"), ("html", "html"), ("htm", "html"), ("css", "css"), ("scss", "scss"), ("sass", "sass"), ("less", "less"), ("json", "json"), ("jsonc", "json"), ("json5", "json5"), ("xml", "xml"), ("svg", "svg"), ("md", "md"), ("markdown", "md"), ("mdx", "mdx"), ("yaml", "yaml"), ("yml", "yaml"), ("toml", "toml"), ("sh", "sh"), ("bash", "sh"), ("zsh", "zsh"), ("shell", "sh"), ("ps1", "ps1"), ("powershell", "ps1"), ("fish", "fish"), ("c", "c"), ("cpp", "cpp"), ("c++", "cpp"), ("cc", "cpp"), ("cxx", "cpp"), ("cs", "cs"), ("csharp", "cs"), ("c#", "cs"), ("rs", "rs"), ("rust", "rs"), ("go", "go"), ("golang", "go"), ("py", "py"), ("python", "py"), ("rb", "rb"), ("ruby", "rb"), ("php", "php"), ("java", "java"), ("kt", "kt"), ("kotlin", "kt"), ("swift", "swift"), ("dart", "dart"), ("r", "r"), ("lua", "lua"), ("sql", "sql"), ("graphql", "graphql"), ("gql", "graphql"), ("proto", "proto"), ("protobuf", "proto"), ("docker", "dockerfile"), ("dockerfile", "dockerfile"), ("makefile", "makefile"), ("make", "makefile"), ("diff", "diff"), ("wasm", "wasm")];

pub fn language_name(language: &str) -> String {
    let wanted = language.trim().to_lowercase();
    if wanted.is_empty() {
        return "Code".to_owned();
    }
    if let Some((_, name)) = LANGUAGES.iter().find(|(key, _)| *key == wanted) {
        return (*name).to_owned();
    }
    let mut chars = wanted.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

pub fn snippet_file_name(language: &str) -> String {
    let wanted = language.trim().to_lowercase();
    let extension = match EXTENSIONS.iter().find(|(key, _)| *key == wanted) {
        Some((_, extension)) => (*extension).to_owned(),
        None if (1..=8).contains(&wanted.len()) && wanted.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') => wanted,
        None => "txt".to_owned(),
    };
    if extension == "dockerfile" || extension == "makefile" {
        extension
    } else {
        format!("snippet.{extension}")
    }
}

pub fn line_count(code: &str) -> usize {
    if code.is_empty() {
        0
    } else {
        code.split('\n').count()
    }
}

pub fn line_count_words(count: usize) -> String {
    if count == 1 {
        "1 line".to_owned()
    } else {
        format!("{count} lines")
    }
}

fn expand_tabs(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut leading = true;
    for c in line.chars() {
        if leading && c == '\t' {
            let pad = 4 - out.chars().count() % 4;
            out.extend(std::iter::repeat_n(' ', pad));
            continue;
        }
        leading &= c == ' ';
        out.push(c);
    }
    out
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn blank(line: &str) -> bool {
    line.trim().is_empty()
}

fn drop_columns(line: &str, columns: usize) -> String {
    let skip = indent(line).min(columns);
    line[skip..].to_owned()
}

struct Fence {
    indent: usize,
    mark: char,
    length: usize,
    info: String,
}

fn fence(line: &str) -> Option<Fence> {
    let lead = indent(line);
    if lead > 3 {
        return None;
    }
    let rest = &line[lead..];
    let mark = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let length = rest.chars().take_while(|c| *c == mark).count();
    if length < 3 {
        return None;
    }
    let info = rest[length..].trim().to_owned();
    if mark == '`' && info.contains('`') {
        return None;
    }
    Some(Fence { indent: lead, mark, length, info })
}

fn closes(line: &str, open: &Fence) -> bool {
    let lead = indent(line);
    if lead > 3 {
        return false;
    }
    let rest = line[lead..].trim_end();
    rest.chars().count() >= open.length && rest.chars().all(|c| c == open.mark)
}

fn heading(line: &str) -> Option<(u8, String)> {
    let lead = indent(line);
    if lead > 3 {
        return None;
    }
    let rest = &line[lead..];
    let level = rest.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let after = &rest[level..];
    if !after.is_empty() && !after.starts_with(' ') {
        return None;
    }
    let mut body = after.trim();
    let stripped = body.trim_end_matches('#');
    if stripped.is_empty() || stripped.ends_with(' ') {
        body = stripped.trim_end();
    }
    Some((level as u8, body.to_owned()))
}

fn rule(line: &str) -> bool {
    if indent(line) > 3 {
        return false;
    }
    let marks: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
    marks.len() >= 3 && matches!(marks[0], '-' | '*' | '_') && marks.iter().all(|c| *c == marks[0])
}

fn setext(line: &str) -> Option<u8> {
    if indent(line) > 3 {
        return None;
    }
    let body = line.trim();
    if !body.is_empty() && body.chars().all(|c| c == '=') {
        return Some(1);
    }
    if !body.is_empty() && body.chars().all(|c| c == '-') {
        return Some(2);
    }
    None
}

fn quoted(line: &str) -> Option<String> {
    let lead = indent(line);
    if lead > 3 || !line[lead..].starts_with('>') {
        return None;
    }
    let rest = &line[lead + 1..];
    Some(rest.strip_prefix(' ').unwrap_or(rest).to_owned())
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Marker {
    ordered: bool,
    start: u64,
    symbol: char,
    content: usize,
    empty: bool,
}

fn marker(line: &str) -> Option<Marker> {
    let lead = indent(line);
    if lead > 3 {
        return None;
    }
    let rest = &line[lead..];
    let (ordered, start, symbol, width) = match rest.chars().next()? {
        c @ ('-' | '+' | '*') => (false, 0, c, 1),
        c if c.is_ascii_digit() => {
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            if digits > 9 {
                return None;
            }
            let symbol = rest[digits..].chars().next().filter(|c| *c == '.' || *c == ')')?;
            (true, rest[..digits].parse().ok()?, symbol, digits + 1)
        }
        _ => return None,
    };
    let after = &rest[width..];
    if !after.is_empty() && !after.starts_with(' ') {
        return None;
    }
    let spaces = indent(after);
    let empty = after.trim().is_empty();
    let gap = if empty || spaces > 4 { 1 } else { spaces };
    Some(Marker { ordered, start, symbol, content: lead + width + gap, empty })
}

fn delimiter_row(line: &str) -> Option<usize> {
    let cells = cells(line);
    let valid = !cells.is_empty()
        && cells.iter().all(|cell| {
            let core = cell.trim_start_matches(':').trim_end_matches(':');
            !core.is_empty() && core.chars().all(|c| c == '-')
        });
    (valid && line.contains('-') && (line.contains('|') || cells.len() > 1)).then_some(cells.len())
}

fn cells(line: &str) -> Vec<String> {
    let mut body = line.trim();
    if let Some(rest) = body.strip_prefix('|') {
        body = rest;
    }
    if body.ends_with('|') && !body.ends_with("\\|") {
        body = &body[..body.len() - 1];
    }
    let mut out = Vec::new();
    let mut cell = String::new();
    let mut escaped = false;
    for c in body.chars() {
        if escaped {
            if c != '|' {
                cell.push('\\');
            }
            cell.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '|' {
            out.push(cell.trim().to_owned());
            cell.clear();
        } else {
            cell.push(c);
        }
    }
    if escaped {
        cell.push('\\');
    }
    out.push(cell.trim().to_owned());
    out
}

fn table_start(lines: &[String], at: usize) -> bool {
    let Some(next) = lines.get(at + 1) else { return false };
    lines[at].contains('|') && indent(&lines[at]) <= 3 && delimiter_row(next) == Some(cells(&lines[at]).len())
}

fn interrupts(lines: &[String], at: usize) -> bool {
    let line = &lines[at];
    fence(line).is_some()
        || heading(line).is_some()
        || quoted(line).is_some()
        || rule(line)
        || marker(line).is_some_and(|found| !found.empty && (!found.ordered || found.start == 1))
        || table_start(lines, at)
}

fn blocks(lines: &[String]) -> Vec<Block> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let line = &lines[at];
        if blank(line) {
            at += 1;
            continue;
        }
        if let Some(open) = fence(line) {
            at += 1;
            let mut body = Vec::new();
            while at < lines.len() && !closes(&lines[at], &open) {
                body.push(drop_columns(&lines[at], open.indent));
                at += 1;
            }
            at += 1;
            let language = open.info.split_whitespace().next().unwrap_or_default().to_owned();
            out.push(Block::Code { language, text: body.join("\n") });
            continue;
        }
        if indent(line) >= 4 {
            let mut body = Vec::new();
            while at < lines.len() && (blank(&lines[at]) || indent(&lines[at]) >= 4) {
                body.push(drop_columns(&lines[at], 4));
                at += 1;
            }
            while body.last().is_some_and(|last| blank(last)) {
                body.pop();
            }
            out.push(Block::Code { language: String::new(), text: body.join("\n") });
            continue;
        }
        if let Some((level, words)) = heading(line) {
            out.push(Block::Heading { level, content: inlines(&words) });
            at += 1;
            continue;
        }
        if rule(line) {
            out.push(Block::Rule);
            at += 1;
            continue;
        }
        if quoted(line).is_some() {
            let mut inner: Vec<String> = Vec::new();
            while at < lines.len() {
                if let Some(rest) = quoted(&lines[at]) {
                    inner.push(rest);
                } else if !blank(&lines[at]) && inner.last().is_some_and(|last| !blank(last)) && !interrupts(lines, at) {
                    inner.push(lines[at].trim_start().to_owned());
                } else {
                    break;
                }
                at += 1;
            }
            out.push(Block::Quote { blocks: blocks(&inner) });
            continue;
        }
        if let Some(first) = marker(line) {
            let (list, next) = list(lines, at, first);
            out.push(list);
            at = next;
            continue;
        }
        if table_start(lines, at) {
            let columns = cells(line).len();
            let mut rows = vec![fit(cells(line), columns)];
            at += 2;
            while at < lines.len() && !blank(&lines[at]) && !interrupts(lines, at) {
                rows.push(fit(cells(&lines[at]), columns));
                at += 1;
            }
            let rows = rows.into_iter().map(|row| row.iter().map(|cell| plain(&inlines(cell))).collect()).collect();
            out.push(Block::Table { rows });
            continue;
        }
        let mut words: Vec<&str> = vec![line.trim_start()];
        at += 1;
        let mut level = None;
        while at < lines.len() && !blank(&lines[at]) {
            if let Some(found) = setext(&lines[at]) {
                level = Some(found);
                at += 1;
                break;
            }
            if interrupts(lines, at) {
                break;
            }
            words.push(lines[at].trim_start());
            at += 1;
        }
        let joined = words.join("\n");
        let content = inlines(joined.trim_end());
        out.push(match level {
            Some(level) => Block::Heading { level, content },
            None => Block::Paragraph { content },
        });
    }
    out
}

fn fit(mut row: Vec<String>, columns: usize) -> Vec<String> {
    row.resize(columns, String::new());
    row
}

fn same_list(first: &Marker, other: &Marker) -> bool {
    first.ordered == other.ordered && first.symbol == other.symbol
}

fn list(lines: &[String], mut at: usize, first: Marker) -> (Block, usize) {
    let mut items = Vec::new();
    while at < lines.len() {
        let Some(found) = marker(&lines[at]).filter(|found| same_list(&first, found)) else { break };
        if rule(&lines[at]) {
            break;
        }
        let line = &lines[at];
        let mut body = vec![if line.len() > found.content { line[found.content..].to_owned() } else { String::new() }];
        at += 1;
        while at < lines.len() {
            let next = &lines[at];
            if blank(next) {
                body.push(String::new());
                at += 1;
                continue;
            }
            if indent(next) >= found.content {
                body.push(next[found.content..].to_owned());
                at += 1;
                continue;
            }
            let after_blank = body.last().is_some_and(|last| blank(last));
            if after_blank || marker(next).is_some() || interrupts(lines, at) {
                break;
            }
            body.push(next.trim_start().to_owned());
            at += 1;
        }
        while body.last().is_some_and(|last| blank(last)) {
            body.pop();
        }
        items.push(blocks(&body));
    }
    (Block::List { ordered: first.ordered, start: first.start, items }, at)
}

enum Token {
    Text(String),
    Node(Inline),
    Run { mark: char, count: usize, open: bool, close: bool },
}

fn punctuation(c: char) -> bool {
    c.is_ascii_punctuation() || (!c.is_alphanumeric() && !c.is_whitespace() && !c.is_ascii())
}

pub fn inlines(source: &str) -> Vec<Inline> {
    emphasis(tokens(source, false))
}

fn push_text(tokens: &mut Vec<Token>, words: &str) {
    if words.is_empty() {
        return;
    }
    if let Some(Token::Text(last)) = tokens.last_mut() {
        last.push_str(words);
    } else {
        tokens.push(Token::Text(words.to_owned()));
    }
}

fn tokens(source: &str, in_link: bool) -> Vec<Token> {
    let chars: Vec<char> = source.chars().collect();
    let mut out: Vec<Token> = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        match c {
            '\\' => {
                match chars.get(at + 1) {
                    Some(next) if next.is_ascii_punctuation() => {
                        push_text(&mut out, &next.to_string());
                        at += 2;
                    }
                    Some('\n') => {
                        out.push(Token::Node(Inline::Break));
                        at += 2;
                    }
                    _ => {
                        push_text(&mut out, "\\");
                        at += 1;
                    }
                }
                continue;
            }
            '`' => {
                let run = chars[at..].iter().take_while(|c| **c == '`').count();
                match code_span(&chars, at, run) {
                    Some((code, end)) => {
                        out.push(Token::Node(Inline::Code { text: code }));
                        at = end;
                    }
                    None => {
                        push_text(&mut out, &"`".repeat(run));
                        at += run;
                    }
                }
                continue;
            }
            '!' if chars.get(at + 1) == Some(&'[') && !in_link => {
                if let Some((label, href, end)) = bracket_link(&chars, at + 1) {
                    let shown = if label.trim().is_empty() { vec![text("Image")] } else { emphasis(tokens(&label, true)) };
                    out.push(Token::Node(Inline::Link { href: link_target(&href), children: shown }));
                    at = end;
                    continue;
                }
            }
            '[' if !in_link => {
                if let Some((label, href, end)) = bracket_link(&chars, at) {
                    out.push(Token::Node(Inline::Link { href: link_target(&href), children: emphasis(tokens(&label, true)) }));
                    at = end;
                    continue;
                }
            }
            '<' => {
                if let Some((href, shown, end)) = angle_link(&chars, at) {
                    if in_link {
                        push_text(&mut out, &shown);
                    } else {
                        out.push(Token::Node(Inline::Link { href: link_target(&href), children: vec![text(&shown)] }));
                    }
                    at = end;
                    continue;
                }
            }
            '&' => {
                if let Some((decoded, end)) = entity(&chars, at) {
                    push_text(&mut out, &decoded);
                    at = end;
                    continue;
                }
            }
            '*' | '_' => {
                let count = chars[at..].iter().take_while(|next| **next == c).count();
                let before = if at == 0 { None } else { Some(chars[at - 1]) };
                let after = chars.get(at + count).copied();
                let space_before = before.is_none_or(char::is_whitespace);
                let space_after = after.is_none_or(char::is_whitespace);
                let punct_before = before.is_some_and(punctuation);
                let punct_after = after.is_some_and(punctuation);
                let left = !space_after && (!punct_after || space_before || punct_before);
                let right = !space_before && (!punct_before || space_after || punct_after);
                let (open, close) = if c == '*' { (left, right) } else { (left && (!right || punct_before), right && (!left || punct_after)) };
                out.push(Token::Run { mark: c, count, open, close });
                at += count;
                continue;
            }
            '\n' => {
                let mut hard = false;
                if let Some(Token::Text(last)) = out.last_mut() {
                    let kept = last.trim_end_matches(' ').len();
                    hard = last.len() - kept >= 2;
                    last.truncate(kept);
                }
                if hard {
                    out.push(Token::Node(Inline::Break));
                } else {
                    push_text(&mut out, " ");
                }
                at += 1;
                continue;
            }
            'h' | 'w' | 'H' | 'W' if !in_link => {
                let boundary = at == 0 || matches!(chars[at - 1], ' ' | '\n' | '*' | '_' | '~' | '(');
                if boundary {
                    if let Some((href, shown, end)) = bare_link(&chars, at) {
                        out.push(Token::Node(Inline::Link { href: link_target(&href), children: vec![text(&shown)] }));
                        at = end;
                        continue;
                    }
                }
            }
            _ => {}
        }
        push_text(&mut out, &c.to_string());
        at += 1;
    }
    out
}

fn code_span(chars: &[char], at: usize, run: usize) -> Option<(String, usize)> {
    let mut look = at + run;
    while look < chars.len() {
        if chars[look] == '`' {
            let close = chars[look..].iter().take_while(|c| **c == '`').count();
            if close == run {
                let inner: String = chars[at + run..look].iter().map(|c| if *c == '\n' { ' ' } else { *c }).collect();
                let trimmed = if inner.len() >= 2 && inner.starts_with(' ') && inner.ends_with(' ') && !inner.trim().is_empty() { inner[1..inner.len() - 1].to_owned() } else { inner };
                return Some((trimmed, look + close));
            }
            look += close;
        } else {
            look += 1;
        }
    }
    None
}

fn bracket_link(chars: &[char], at: usize) -> Option<(String, String, usize)> {
    let mut depth = 0usize;
    let mut look = at;
    let close = loop {
        let c = *chars.get(look)?;
        match c {
            '\\' => look += 2,
            '`' => {
                let run = chars[look..].iter().take_while(|c| **c == '`').count();
                look = code_span(chars, look, run).map_or(look + run, |(_, end)| end);
            }
            '[' => {
                depth += 1;
                look += 1;
            }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    break look;
                }
                look += 1;
            }
            _ => look += 1,
        }
    };
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let mut look = close + 2;
    while chars.get(look).is_some_and(|c| *c == ' ' || *c == '\n') {
        look += 1;
    }
    let mut href = String::new();
    if chars.get(look) == Some(&'<') {
        look += 1;
        loop {
            match *chars.get(look)? {
                '>' => {
                    look += 1;
                    break;
                }
                '\n' | '<' => return None,
                '\\' if chars.get(look + 1).is_some_and(char::is_ascii_punctuation) => {
                    href.push(chars[look + 1]);
                    look += 2;
                }
                c => {
                    href.push(c);
                    look += 1;
                }
            }
        }
    } else {
        let mut parens = 0usize;
        while let Some(&c) = chars.get(look) {
            if c.is_whitespace() || c.is_control() {
                break;
            }
            if c == '\\' && chars.get(look + 1).is_some_and(char::is_ascii_punctuation) {
                href.push(chars[look + 1]);
                look += 2;
                continue;
            }
            if c == '(' {
                parens += 1;
            } else if c == ')' {
                if parens == 0 {
                    break;
                }
                parens -= 1;
            }
            href.push(c);
            look += 1;
        }
    }
    while chars.get(look).is_some_and(|c| *c == ' ' || *c == '\n') {
        look += 1;
    }
    if let Some(&quote) = chars.get(look).filter(|c| matches!(**c, '"' | '\'' | '(')) {
        let end = if quote == '(' { ')' } else { quote };
        look += 1;
        while *chars.get(look)? != end {
            look += if chars[look] == '\\' { 2 } else { 1 };
        }
        look += 1;
        while chars.get(look).is_some_and(|c| *c == ' ' || *c == '\n') {
            look += 1;
        }
    }
    if chars.get(look) != Some(&')') {
        return None;
    }
    let label: String = chars[at + 1..close].iter().collect();
    Some((label, href, look + 1))
}

fn angle_link(chars: &[char], at: usize) -> Option<(String, String, usize)> {
    let end = chars[at + 1..].iter().position(|c| *c == '>' || *c == '<' || c.is_whitespace()).map(|offset| at + 1 + offset)?;
    if chars[end] != '>' {
        return None;
    }
    let inner: String = chars[at + 1..end].iter().collect();
    let scheme_end = inner.find(':');
    let is_uri = scheme_end.is_some_and(|colon| {
        let scheme = &inner[..colon];
        (2..=32).contains(&scheme.len()) && scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if is_uri {
        return Some((inner.clone(), inner, end + 1));
    }
    let is_email = inner.split_once('@').is_some_and(|(user, host)| {
        !user.is_empty() && host.contains('.') && !host.starts_with('.') && !host.ends_with('.') && user.chars().all(|c| c.is_ascii_alphanumeric() || ".!#$%&'*+/=?^_`{|}~-".contains(c)) && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    });
    is_email.then(|| (format!("mailto:{inner}"), inner, end + 1))
}

fn bare_link(chars: &[char], at: usize) -> Option<(String, String, usize)> {
    let rest: String = chars[at..chars.len().min(at + 8)].iter().collect::<String>().to_ascii_lowercase();
    let prefix = ["https://", "http://", "www."].into_iter().find(|prefix| rest.starts_with(prefix))?;
    let mut end = at;
    while end < chars.len() && !chars[end].is_whitespace() && chars[end] != '<' {
        end += 1;
    }
    loop {
        let last = chars[end - 1];
        let opened = chars[at..end].iter().filter(|c| **c == '(').count();
        let closed = chars[at..end].iter().filter(|c| **c == ')').count();
        if matches!(last, '?' | '!' | '.' | ',' | ':' | '*' | '_' | '~' | '"' | '\'') || (last == ')' && closed > opened) {
            end -= 1;
        } else {
            break;
        }
        if end <= at {
            return None;
        }
    }
    let shown: String = chars[at..end].iter().collect();
    if shown.len() <= prefix.len() {
        return None;
    }
    let href = if prefix == "www." { format!("http://{shown}") } else { shown.clone() };
    Some((href, shown, end))
}

fn entity(chars: &[char], at: usize) -> Option<(String, usize)> {
    let end = chars[at..chars.len().min(at + 12)].iter().position(|c| *c == ';').map(|offset| at + offset)?;
    let name: String = chars[at + 1..end].iter().collect();
    let decoded = match name.as_str() {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        _ => {
            let number = name.strip_prefix('#')?;
            let value = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse().ok()?,
            };
            char::from_u32(value).filter(|c| *c != '\0').unwrap_or('\u{fffd}')
        }
    };
    Some((decoded.to_string(), end + 1))
}

fn emphasis(mut tokens: Vec<Token>) -> Vec<Inline> {
    let mut closer = 0;
    while closer < tokens.len() {
        let Token::Run { mark, count: close_count, open: close_opens, close: true } = tokens[closer] else {
            closer += 1;
            continue;
        };
        if close_count == 0 {
            closer += 1;
            continue;
        }
        let opener = (0..closer).rev().find(|index| match tokens[*index] {
            Token::Run { mark: other, count, open: true, close: opens_closes } => {
                let odd = (opens_closes || close_opens) && (count + close_count) % 3 == 0 && !(count % 3 == 0 && close_count % 3 == 0);
                other == mark && count > 0 && !odd
            }
            _ => false,
        });
        let Some(opener) = opener else {
            closer += 1;
            continue;
        };
        let Token::Run { count: open_count, .. } = tokens[opener] else { unreachable!() };
        let used = if open_count >= 2 && close_count >= 2 { 2 } else { 1 };
        let inner: Vec<Token> = tokens.drain(opener + 1..closer).collect();
        let children = flatten(inner);
        let node = if used == 2 { Inline::Strong { children } } else { Inline::Emphasis { children } };
        tokens.insert(opener + 1, Token::Node(node));
        let mut at_closer = opener + 2;
        if let Token::Run { count, .. } = &mut tokens[opener] {
            *count -= used;
        }
        if let Token::Run { count, .. } = &mut tokens[at_closer] {
            *count -= used;
        }
        if matches!(tokens[opener], Token::Run { count: 0, .. }) {
            tokens.remove(opener);
            at_closer -= 1;
        }
        if matches!(tokens[at_closer], Token::Run { count: 0, .. }) {
            tokens.remove(at_closer);
        }
        closer = at_closer;
    }
    flatten(tokens)
}

fn flatten(tokens: Vec<Token>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    for token in tokens {
        let words = match token {
            Token::Node(node) => {
                out.push(node);
                continue;
            }
            Token::Text(words) => words,
            Token::Run { mark, count, .. } => mark.to_string().repeat(count),
        };
        if words.is_empty() {
            continue;
        }
        if let Some(Inline::Text { text }) = out.last_mut() {
            text.push_str(&words);
        } else {
            out.push(Inline::Text { text: words });
        }
    }
    out
}

const PREVIEW_SOURCE_LIMIT: usize = 4_000;

fn preview_blocks(blocks: &[Block], prose: &mut String, code: &mut String) {
    for block in blocks {
        prose.push(' ');
        match block {
            Block::Paragraph { content } | Block::Heading { content, .. } => prose.push_str(&plain(content).replace('\n', " ")),
            Block::Code { text, .. } => {
                code.push(' ');
                code.push_str(text);
                code.push(' ');
            }
            Block::List { ordered, start, items } => {
                for (index, item) in items.iter().enumerate() {
                    if *ordered {
                        prose.push_str(&format!(" {}. ", start + index as u64));
                    }
                    preview_blocks(item, prose, code);
                }
            }
            Block::Quote { blocks } => preview_blocks(blocks, prose, code),
            Block::Table { rows } => {
                for cell in rows.iter().flatten() {
                    prose.push(' ');
                    prose.push_str(cell);
                    prose.push(' ');
                }
            }
            Block::Rule => {}
        }
        prose.push(' ');
    }
}

fn one_line(words: &str) -> String {
    words.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn preview(source: &str) -> String {
    let clipped: String = source.chars().take(PREVIEW_SOURCE_LIMIT).collect();
    let mut prose = String::new();
    let mut code = String::new();
    preview_blocks(&parse(&clipped), &mut prose, &mut code);
    let line = one_line(&prose);
    if line.is_empty() {
        one_line(&code)
    } else {
        line
    }
}
