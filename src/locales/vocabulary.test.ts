import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import en from "./en.json";
import { locales } from "./index";

// One name per thing, in every word a person reads (scripts/brand-links.test.ts keeps every other project's name out
// of the repository altogether):
// - later.dog: the app.
// - later.dog Cloud: a Cloud the build names, and its sign-in in Settings.
// - My Cloud: the person's always-on home in the cloud.
// - Cloud computer: a desktop in the cloud that a bot uses.
// - This computer: the device the app runs on.
// - Plan page: the web page with the plan, payments and use.
// "Local VM" keeps its name. "Cloud" alone never names a Works on choice, and
// "Boat" names only the provider behind a person's own key (Settings → Computer).
const RETIRED: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["Cloud box", /Cloud box/i, "Cloud computer"],
  ["Hosted desktop", /Hosted desktop/i, "Cloud computer"],
  ["Cloud VM", /Cloud VM/i, "Cloud computer"],
  ["Boat cloud runner", /Boat cloud runner/i, "Cloud computer"],
  ["Cloud dashboard", /Cloud dashboard/i, "Plan page"],
  ["Connect to my Cloud", /Connect to my Cloud/i, "Open My Cloud"],
  ["your Cloud", /\b[Yy]our Cloud\b(?! plan| account| sign-in| subscription)/, "My Cloud"],
  ["my Cloud", /\bmy Cloud\b/, "My Cloud"],
  ["Local (this computer)", /Local \(this computer\)/, "This computer"],
  ["Cloud as a Works on choice", /\b(?:[Cc]hoose|[Ss]elect) Cloud\b(?! computer)|\bAuto, Cloud\b(?! computer)|, Cloud, /, "Cloud computer"],
  ["T3", /\bT3\b/, "no other app's name"],
];

// The pets are dogs, and English copy says so, with the plain meaning beside
// the dog word: a skill a person teaches is a trick ("Tricks are skills you
// teach a dog…"), New Bot is New dog, and the two approval levels are Heel
// ("Checks with you before commands and file changes") and Off-leash ("Acts, then tells you").
// Only en.json is checked: identifiers, model-facing prompts, file names such
// as SKILL.md and other products' names keep their own words.
const RETIRED_EN: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["Skills", /\bSkills\b/, "Tricks"],
  ["New Bot", /\bNew [Bb]ot\b/, "New dog"],
  ["Ask me first", /\bAsk me first\b/i, "Heel"],
  ["Decide for me", /\bDecide for me\b/i, "Off-leash"],
];

/** The dog words a piece of English copy is missing. */
function retiredDogWordsIn(text: string): string[] {
  return RETIRED_EN.filter(([, pattern]) => pattern.test(text)).map(([word, , use]) => `"${word}" (say ${use})`);
}

/** "Boat" inside these phrases names the provider of a person's own key. */
const OWN_KEY = /Boat (?:API key|account|key|token|plan|provider|credentials|setup|is not configured|is not connected|is a paid service)|boat\.dev|\b(?:Connect|Configure) Boat\b/g;
const BOAT = /\bBoats?\b/;

/** What a piece of copy still says that the vocabulary retired. */
function retiredIn(text: string, boat: RegExp = BOAT): string[] {
  const found = RETIRED.filter(([, pattern]) => pattern.test(text)).map(([word, , use]) => `"${word}" (say ${use})`);
  if (boat.test(text.replace(OWN_KEY, ""))) found.push(`"Boat" (say cloud computer; Boat only names a person's own key)`);
  return found;
}

const PENDING_KEY_PREFIXES: string[] = [];
const EN_ALLOWED: Record<string, string> = {};

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCANNED = ["src", "server", "electron", "shared"];
// Test fixtures and generated output are not copy anyone reads.
const SKIPPED_DIRS = new Set(["node_modules", "resources", "testing", "dist"]);
const isSource = (name: string) => /\.(?:ts|tsx|mjs|cjs|js)$/.test(name) && !/\.test\.|\.node-test\.|\.d\.ts$/.test(name);

/** Hard-coded strings that keep a retired word on purpose. A file with no
 * snippet keeps it everywhere; otherwise only literals containing a snippet. */
const ALLOWED: ReadonlyArray<{ file: string; snippet?: string; why: string }> = [
  { file: "src/components/CloudBackendPicker.tsx", why: "the own-key provider picker names its two providers, Boat and a VPS" },
  { file: "shared/credential-request.ts", snippet: "when Boat is selected", why: "the card that asks for a person's own Boat key" },
  { file: "server/boat-create-idempotency.ts", snippet: "unnamed Boat", why: "own-key repair: boat.dev's own name for a machine" },
];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (isSource(name)) yield path;
  }
}

/** Every string a source file could show: literals, template text and JSX
 * text, never comments or identifiers. */
function literals(path: string): Array<{ line: number; text: string }> {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(?:mjs|cjs|js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, kind);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Every hard-coded string that says a retired word, before the allow-list. */
function hardcodedFindings(): Array<{ file: string; line: number; text: string; what: string[] }> {
  const found: Array<{ file: string; line: number; text: string; what: string[] }> = [];
  for (const top of SCANNED) {
    for (const path of sources(join(ROOT, top))) {
      const file = relative(ROOT, path).split("\\").join("/");
      for (const { line, text } of literals(path)) {
        const what = retiredIn(text);
        if (what.length > 0) found.push({ file, line, text, what });
      }
    }
  }
  return found;
}

const allows = (entry: (typeof ALLOWED)[number], finding: { file: string; text: string }) =>
  entry.file === finding.file && (entry.snippet === undefined || finding.text.includes(entry.snippet));

describe("one name per thing", () => {
  it("English copy uses later.dog, later.dog Cloud, My Cloud, Cloud computer, This computer and Plan page", () => {
    const offending = Object.entries(en as Record<string, string>)
      .filter(([key]) => !PENDING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) && !Object.hasOwn(EN_ALLOWED, key))
      // English keys are UI copy, so lower-case "boat" counts too.
      .flatMap(([key, value]) => retiredIn(value, /\bboats?\b/i).map((what) => `${key}: ${what}`));
    expect(offending).toEqual([]);
  });

  it("English copy says Tricks, New dog, Heel and Off-leash", () => {
    const offending = Object.entries(en as Record<string, string>)
      .flatMap(([key, value]) => retiredDogWordsIn(value).map((what) => `${key}: ${what}`));
    expect(offending).toEqual([]);
  });

  it("the dog-word check catches Skills, New Bot, Ask me first and Decide for me, and lets their plain meaning through", () => {
    for (const bad of ["Skills", "Skills library", "Included skills · Skills: 3", "New Bot", "Remove from New bot", "Ask me first", "Decide for me"]) {
      expect(retiredDogWordsIn(bad), bad).not.toEqual([]);
    }
    for (const good of [
      "Tricks", "Teach a trick", "No tricks yet.", "Tricks are skills you teach a dog: a playbook it follows when asked.",
      "Paste a SKILL.md file", "New dog", "Heel", "Checks with you before commands and file changes", "Off-leash", "Acts, then tells you",
      "Ask me before contacting other dogs",
    ]) expect(retiredDogWordsIn(good), good).toEqual([]);
  });

  it("translations never show T3, and say Boat only where the English does", () => {
    const offending = Object.entries(locales).filter(([code]) => code !== "en").flatMap(([code, pack]) =>
      Object.entries(pack)
        .filter(([key]) => !PENDING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
        .filter(([key, value]) => /\bT3\b/.test(value!) || (/boat/i.test(value!) && !/\bboats?\b/i.test((en as Record<string, string>)[key]!)))
        .map(([key]) => `${code}: ${key}`));
    expect([...new Set(offending)]).toEqual([]);
  });

  it("hard-coded strings in src, server, electron and shared use the same words", () => {
    const findings = hardcodedFindings();
    const offending = findings
      .filter((finding) => !ALLOWED.some((entry) => allows(entry, finding)))
      .flatMap(({ file, line, text, what }) => what.map((one) => `${file}:${line}: ${one}: ${JSON.stringify(text.trim().slice(0, 120))}`));
    expect(offending).toEqual([]);
    // An entry that no longer matches anything has outlived its reason.
    const stale = ALLOWED.filter((entry) => !findings.some((finding) => allows(entry, finding)))
      .map((entry) => `${entry.file}${entry.snippet ? ` (${entry.snippet})` : ""}`);
    expect(stale).toEqual([]);
    const staleKeys = Object.keys(EN_ALLOWED).filter((key) => !Object.hasOwn(en, key) || retiredIn((en as Record<string, string>)[key]!, /\bboats?\b/i).length === 0);
    expect(staleKeys).toEqual([]);
  });

  it("copy that points at a control names it exactly as the control is labelled", () => {
    const e = en as Record<string, string>;
    const source = (file: string) => readFileSync(join(ROOT, file), "utf8");
    const settings = `Settings → ${e["settings.section.cloudAccount"]}`;
    // The menus' own names for the two places: the Server menu and the sidebar switcher.
    const myCloud = /CLOUD_HOME_NAME = "([^"]+)"/.exec(source("electron/cloud-home.mjs"))?.[1];
    const thisComputer = /id: "workspace-local", label: "([^"]+)"/.exec(source("electron/environments.cjs"))?.[1];
    const serverMenuLocal = /\{ label: "([^"]+)", type: "radio", checked: !active/.exec(source("electron/menu.mjs"))?.[1];
    expect([myCloud, thisComputer, serverMenuLocal]).toEqual([e["cloudSetup.myCloud"], e["place.local"], e["place.local"]]);
    const pointers: Array<[string, string[]]> = [
      ["cloudSetup.lend.hint", [e["cloudHome.connect"]!]],
      ["cloudHome.connectHelp", [e["place.local"]!]],
      ["cloudPhone.step1", [myCloud!]],
      ["lending.status.connectFirst", [e["cloudHome.connect"]!]],
      ["computer.worksOnHintCloudHome", [e["lending.title"]!, settings]],
      ["cloudAccount.onCloudSignIn", [e["cloudAccount.signInAgain"]!, settings]],
      ["cloudAccount.storageFailed", [e["cloudAccount.signOut"]!]],
      ["cloudAccount.codeExpired", [e["cloudAccount.signIn"]!]],
      ["computer.routines.offWarning", [e["routines.runsOn.boat"]!]],
    ];
    const stale = pointers.flatMap(([key, labels]) => labels.filter((label) => !e[key]!.includes(label)).map((label) => `${key} → ${label}`));
    expect(stale).toEqual([]);
  });

  it("the check catches each retired word, and lets own-key Boat and env names through", () => {
    for (const bad of [
      "Cloud box", "Hosted desktop", "Run it in its cloud VM", "Boat cloud runner",
      "Open your Cloud dashboard", "Connect to my Cloud", "Your Cloud is ready", "Let my Cloud use this Mac",
      "Local (this computer)", "Choose Cloud to wake", "Auto, Cloud or Browser", "including one from T3",
      "Auto uses this Boat", "New Boat computer",
    ]) expect(retiredIn(bad), bad).not.toEqual([]);
    for (const good of [
      "Sign in to later.dog Cloud", "Welcome to later.dog", "set LATERDOG_PUBLIC_IPV4", "Open My Cloud", "Choose Cloud computer to wake",
      "Included with your Cloud plan", "Add a Boat key in Settings → Computer", "Connect Boat", "Check boat.dev",
      "Local VM", "Open your Plan page",
    ]) expect(retiredIn(good), good).toEqual([]);
  });
});
