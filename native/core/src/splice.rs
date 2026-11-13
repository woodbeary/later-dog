#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Splice {
    Nothing,
    Rows(Vec<usize>),
    Append { from: usize, changed: Vec<usize> },
    Prepend { removed: usize, added: usize },
    Reload,
}

pub const MOST_CHANGED_ON_APPEND: usize = 2;

fn changed<T: PartialEq>(old: &[T], new: &[T]) -> Vec<usize> {
    old.iter().zip(new).enumerate().filter(|(_, (before, after))| before != after).map(|(index, _)| index).collect()
}

pub fn splice<T: PartialEq>(old: &[T], new: &[T]) -> Splice {
    if old.is_empty() {
        return if new.is_empty() { Splice::Nothing } else { Splice::Reload };
    }
    if old.len() == new.len() {
        let rows = changed(old, new);
        return if rows.is_empty() { Splice::Nothing } else if rows.len() == old.len() { Splice::Reload } else { Splice::Rows(rows) };
    }
    if new.len() > old.len() {
        for removed in 0..=1 {
            let kept = &old[removed..];
            if !kept.is_empty() && new.ends_with(kept) {
                return Splice::Prepend { removed, added: new.len() - kept.len() };
            }
        }
        let rows = changed(old, &new[..old.len()]);
        if rows.len() <= MOST_CHANGED_ON_APPEND && rows.iter().all(|row| *row + MOST_CHANGED_ON_APPEND >= old.len()) {
            return Splice::Append { from: old.len(), changed: rows };
        }
    }
    Splice::Reload
}
