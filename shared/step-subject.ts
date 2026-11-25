export const STEP_GERUNDS: Readonly<Record<string, string>> = {
  add: "adding",
  analyze: "analyzing",
  apply: "applying",
  build: "building",
  call: "calling",
  capture: "capturing",
  check: "checking",
  clean: "cleaning",
  clone: "cloning",
  close: "closing",
  commit: "committing",
  compare: "comparing",
  compile: "compiling",
  confirm: "confirming",
  convert: "converting",
  copy: "copying",
  count: "counting",
  create: "creating",
  debug: "debugging",
  delete: "deleting",
  deploy: "deploying",
  download: "downloading",
  ensure: "ensuring",
  extract: "extracting",
  fetch: "fetching",
  find: "finding",
  fix: "fixing",
  format: "formatting",
  generate: "generating",
  get: "getting",
  inspect: "inspecting",
  install: "installing",
  kill: "stopping",
  launch: "launching",
  lint: "linting",
  list: "listing",
  load: "loading",
  look: "looking",
  make: "making",
  measure: "measuring",
  merge: "merging",
  move: "moving",
  open: "opening",
  parse: "parsing",
  print: "printing",
  pull: "pulling",
  push: "pushing",
  query: "querying",
  read: "reading",
  rebuild: "rebuilding",
  remove: "removing",
  rename: "renaming",
  render: "rendering",
  rerun: "rerunning",
  reset: "resetting",
  resolve: "resolving",
  restart: "restarting",
  retry: "retrying",
  review: "reviewing",
  run: "running",
  save: "saving",
  scan: "scanning",
  search: "searching",
  send: "sending",
  set: "setting",
  show: "showing",
  start: "starting",
  stop: "stopping",
  summarize: "summarizing",
  sync: "syncing",
  take: "taking",
  test: "testing",
  trace: "tracing",
  typecheck: "typechecking",
  update: "updating",
  upload: "uploading",
  validate: "validating",
  verify: "verifying",
  view: "viewing",
  wait: "waiting",
  watch: "watching",
  write: "writing",
};

export function longStepSubject(outcome: string, subject: string | undefined): string | null {
  const plain = subject?.trim();
  if (!plain || plain.length > 120 || /[\r\n\t/\\.:$\x60|;=<>{}[\]]/u.test(plain)) return null;
  if (!/^[\p{L}\p{N} '"’(),&!?-]+$/u.test(plain)) return null;
  if (
    /\b(?:mcp__\w+|exec_command|run_command|read_file|pnpm|npm|npx|yarn|bash|curl|wget|sudo|node|git|echo|printf|cat|rm|python\d*)\b/i.test(
      plain,
    )
  )
    return null;
  const words = plain.split(/\s+/u);
  if (words.length > 18) return null;
  const named = plain.replace(/^the\s+/i, "");
  switch (outcome) {
    case "read":
      return `Reading the ${named}`;
    case "edit":
      return `Changing the ${named}`;
    case "wrote":
      return `Writing the ${named}`;
    case "search":
      return `Searching for “${plain}”`;
    case "web":
    case "page":
    case "open":
      return `Looking up ${plain}`;
    case "command":
    case "check":
    case "cloud": {
      const verb = STEP_GERUNDS[words[0]!.toLowerCase()];
      return verb
        ? [verb.charAt(0).toUpperCase() + verb.slice(1), ...words.slice(1)].join(" ")
        : null;
    }
    default:
      return null;
  }
}
