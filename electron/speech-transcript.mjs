const SHRUNK = 0.5;
const KEPT = 0.8;
const SHARED = 0.6;

function sharedPrefix(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

function sameUtterance(current, next, ended) {
  if (!current) return true;
  if (ended) return next.length >= current.length * KEPT && sharedPrefix(current, next) >= current.length * SHARED;
  return next.length >= current.length * SHRUNK;
}

const joined = (head, tail) => (head && tail ? `${head} ${tail}` : head || tail);

export function speechTranscript() {
  let committed = "";
  let current = "";
  let ended = false;
  return (line) => {
    if (!line || typeof line !== "object" || typeof line.text !== "string") return line;
    const next = line.text.trim();
    const repeated = next !== "" && next === current;
    if (next && !repeated) {
      if (!sameUtterance(current, next, ended)) committed = joined(committed, current);
      current = next;
    }
    ended = repeated || (ended && !next);
    return { ...line, text: joined(committed, current) };
  };
}
