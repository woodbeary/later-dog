const SHRUNK = 0.5;
const KEPT = 0.8;
const SHARED = 0.6;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function words(text) {
  return [...segmenter.segment(text.toLowerCase())].filter((part) => part.isWordLike).map((part) => part.segment);
}

function sharedWords(left, right) {
  let row = Array.from({ length: right.length + 1 }, () => 0);
  for (const word of left) {
    const next = [0];
    for (let index = 0; index < right.length; index += 1) {
      next.push(word === right[index] ? row[index] + 1 : Math.max(row[index + 1], next[index]));
    }
    row = next;
  }
  return row[right.length];
}

function sameUtterance(current, next, ended) {
  if (!current) return true;
  if (ended) {
    const before = words(current);
    return next.length >= current.length * KEPT && sharedWords(before, words(next)) >= before.length * SHARED;
  }
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
