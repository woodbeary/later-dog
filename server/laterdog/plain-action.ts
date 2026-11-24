const STEPS: { test: RegExp; words: string }[] = [
  { test: /\bgit\s+push\b/, words: "send code to GitHub" },
  { test: /\bgit\s+worktree\s+remove\b/, words: "remove a scratch copy of the code" },
  { test: /\brm\s+-[a-z]*[rf]|\brm\b|\brmdir\b|\bgit\s+clean\b|\bgit\s+branch\s+-D\b/, words: "delete files or a scratch folder" },
  { test: /\bgit\s+reset\s+--hard\b/, words: "discard unsaved changes" },
  { test: /\bgit\s+commit\b/, words: "save a commit" },
  { test: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b|\bbrew\s+install\b|\bpip3?\s+install\b/, words: "install software" },
  { test: /\bcurl\b|\bwget\b/, words: "fetch something from the web" },
  { test: /\bssh\b|\bscp\b|\brsync\b/, words: "connect to another computer" },
  { test: /\bkill(?:all)?\b|\bpkill\b/, words: "stop a running program" },
  { test: /\bchmod\b|\bchown\b|\bsudo\b/, words: "change file permissions" },
  { test: /\bdocker\b/, words: "run a container" },
  { test: /\bmv\b|\bcp\b/, words: "move or copy files" },
];
const COMMANDISH = /^\s*(?:sudo\s+|cd\s+\S+\s*&&\s*)*(?:rm|rmdir|git|npm|pnpm|yarn|bun|curl|wget|ssh|scp|rsync|kill|killall|pkill|chmod|chown|docker|mv|cp|brew|pip3?|sh|bash|zsh|node|python3?|cd|ls|cat|find|xargs|env|export|source|make)\b|&&|\|\||\$\(|\s--?[a-z][\w-]*\s/i;

export function looksLikeCommand(detail: string): boolean {
  return COMMANDISH.test(detail.trim());
}

export function plainAction(detail: string): string | null {
  if (!looksLikeCommand(detail)) return null;
  for (const step of STEPS) if (step.test.test(detail)) return step.words;
  return "run a command on your computer";
}
