
export type Place = "cloud" | "vm" | "local" | "browser";

export const PLACE_STATES = [
  "auto",
  "cc-cannot", "cc-tools-off", "cc-sign-in", "cc-new", "cc-starting", "cc-waking", "cc-on", "cc-asleep",
  "cc-no-hours", "cc-at-once", "cc-trial-one", "cc-unavailable", "cc-ended", "cc-no-start", "cc-clearing", "cc-provider",
  "cc-on-my-cloud", "cc-needs-key", "vps",
  "browser", "browser-off", "browser-cannot",
  "local", "local-unavailable", "vm", "vm-cannot", "place-failed",
  "off",
] as const;
export type PlaceState = (typeof PLACE_STATES)[number];

export type PlaceSource = "works-on" | "pin" | "auto-pin" | "routine" | "room";

export const PLACE_ACTIONS = [
  "choose-model", "allow-computer", "sign-in", "start", "wake", "watch", "see-plan", "get-cloud", "manage-computers",
  "try-again", "open-my-cloud", "turn-on-browser", "open-vm-settings",
  "clear-pin", "change-routine", "open-computer-panel",
] as const;
export type PlaceActionId = (typeof PLACE_ACTIONS)[number];

export interface PlaceRow {
  state: PlaceState;
  params: PlaceParams;
  source: PlaceSource;
}

export interface PlaceParams {
  bot?: string;
  engine?: string;
  model?: string;
  computer?: string;
  hours?: number;
  month?: string;
  plan?: string;
  max?: number;
  holders?: string[];
  words?: string;
  reason?: string;
  cause?: string;
}

export interface PlaceAction {
  id: PlaceActionId;
  label: string;
}

export interface PlaceView {
  state: PlaceState;
  params: PlaceParams;
  short: string;
  line: string;
  action: PlaceAction | null;
}

export type ServerKind = "my-cloud" | "mac" | "pc" | "linux";

type AutoReach = "both" | "cloud" | "local" | "none";

const AUTO_LINE: Record<AutoReach, PlaceKey> = {
  both: "place.view.auto.lineBoth",
  cloud: "place.view.auto.lineCloud",
  local: "place.view.auto.lineLocal",
  none: "place.view.auto.lineNone",
};

export interface PlaceFacts {
  place: Place | "auto" | "off";
  server: ServerKind;
  bot: string;
  plan?: boolean;
  boat: "included" | "own-key" | "none";
  backend?: "box" | "vps";
  engine: {
    name: string;
    model?: string;
    computer: boolean;
    browser: boolean;
    signedIn: boolean;
  };
  toolsAllowComputer: boolean;
  browserOn: boolean;
  role: "admin" | "user";
  computer?: "none" | "starting" | "waking" | "on" | "asleep";
  local?: { ready: boolean; reason?: string };
  refusal?: { state: PlaceState; params: PlaceParams };
}

export const PLACE_EN = {
  "place.view.auto.short": "Chooses for you",
  "place.view.auto.lineBoth": "Picks its cloud computer or this computer when a task needs one.",
  "place.view.auto.lineCloud": "Starts its cloud computer when a task needs one.",
  "place.view.auto.lineLocal": "Uses this computer when a task needs one.",
  "place.view.auto.lineNone": "Works without a computer for now.",
  "place.view.ccCannot.short": "Not with this model",
  "place.view.ccCannot.line": "{model} can't use a computer. Choose a model that can, such as Claude or ChatGPT.",
  "place.view.ccToolsOff.short": "Not allowed",
  "place.view.ccToolsOff.line": "What {bot} can use doesn't include a computer.",
  "place.view.ccSignIn.short": "Sign in first",
  "place.view.ccSignIn.line": "Sign in to {engine} first. {bot} uses it on the cloud computer too.",
  "place.view.ccSignIn.lineMyCloud": "Sign in to {engine} on My Cloud first. {bot} uses it on the cloud computer too.",
  "place.view.ccNew.short": "Ready",
  "place.view.ccNew.line": "{bot} gets its own cloud computer the first time a task needs one. The first start takes about a minute.",
  "place.view.ccStarting.short": "Starting…",
  "place.view.ccStarting.line": "Starting {bot}'s cloud computer. The first start takes about a minute.",
  "place.view.ccWaking.short": "Waking…",
  "place.view.ccWaking.line": "Waking {bot}'s cloud computer. This takes a few seconds.",
  "place.view.ccOn.short": "On",
  "place.view.ccOn.line": "{bot}'s cloud computer is on.",
  "place.view.ccAsleep.short": "Asleep",
  "place.view.ccAsleep.line": "{bot}'s cloud computer is asleep. It wakes in a few seconds when {bot} needs it.",
  "place.view.ccNoHours.short": "No hours left",
  "place.view.ccNoHours.line": "This month's {hours} cloud computer hours are used up. They come back on 1 {month}.",
  "place.view.ccNoHours.lineUnknown": "This month's cloud computer hours are used up.",
  "place.view.ccAtOnce.short": "In use",
  "place.view.ccAtOnce.lineOne": "Your {plan} plan includes 1 cloud computer, and {holders} has it.",
  "place.view.ccAtOnce.lineMany": "Your {plan} plan includes {max} cloud computers, and {holders} have them.",
  "place.view.ccAtOnce.lineUnknown": "All the cloud computers your plan includes are in use.",
  "place.view.ccTrialOne.short": "In use",
  "place.view.ccTrialOne.line": "The free trial includes one cloud computer, and {holders} has it.",
  "place.view.ccTrialOne.lineUnknown": "The free trial includes one cloud computer, and another dog has it.",
  "place.view.ccUnavailable.short": "Not available now",
  "place.view.ccUnavailable.line": "Cloud computers can't start right now. It isn't anything you did.",
  "place.view.ccEnded.short": "Plan ended",
  "place.view.ccEnded.line": "Your later.dog Cloud plan has ended, so cloud computers are off.",
  "place.view.ccNoStart.short": "Didn't start",
  "place.view.ccNoStart.line": "{bot}'s cloud computer didn't start.",
  "place.view.ccClearing.short": "Clearing up",
  "place.view.ccClearing.line": "{bot}'s previous cloud computer is still being removed.",
  "place.view.ccProvider.short": "Couldn't start",
  "place.view.ccProvider.line": "{bot}'s cloud computer couldn't start: {words}",
  "place.view.ccOnMyCloud.short": "On My Cloud",
  "place.view.ccOnMyCloud.line": "Cloud computers from your plan work for dogs on My Cloud for now.",
  "place.view.ccNeedsKey.short": "Not set up",
  "place.view.ccNeedsKey.line": "Cloud computers aren’t set up here yet.",
  "place.view.vps.short": "Your server",
  "place.view.vps.line": "Uses your own server, connected over SSH.",
  "place.view.browser.short": "Web pages only",
  "place.view.browser.line": "Works in the built-in browser only: web pages, no desktop apps.",
  "place.view.browserOff.short": "Browser is off",
  "place.view.browserOff.line": "The built-in browser is switched off.",
  "place.view.browserCannot.short": "Not with this model",
  "place.view.browserCannot.line": "{model} can't use the built-in browser.",
  "place.view.local.short": "Your screen",
  "place.view.local.line": "Uses your screen, mouse, and keyboard.",
  "place.view.localUnavailable.short": "Not ready",
  "place.view.localUnavailable.line": "{reason}",
  "place.view.vm.short": "Private desktop",
  "place.view.vm.line": "A private Linux desktop on this device, separate from your own screen.",
  "place.view.vmCannot.short": "Not with this model",
  "place.view.vmCannot.line": "{model} can't use a Local VM. Choose a model that can, such as Claude or ChatGPT.",
  "place.view.placeFailed.short": "Didn't start",
  "place.view.placeFailed.line": "{cause}",
  "place.view.off.short": "No screen",
  "place.view.off.line": "{bot} has no screen. It can still chat and do anything that doesn't need one.",
  "place.action.chooseModel": "Choose a model",
  "place.action.allowComputer": "Let {bot} use the computer",
  "place.action.signIn": "Sign in",
  "place.action.start": "Start it now",
  "place.action.wake": "Wake it now",
  "place.action.watch": "Watch",
  "place.action.seePlan": "See your plan",
  "place.action.getCloud": "Get later.dog Cloud",
  "place.action.manageComputers": "Manage cloud computers",
  "place.action.tryAgain": "Try again",
  "place.action.openMyCloud": "Open My Cloud",
  "place.action.turnOnBrowser": "Turn on the browser",
  "place.action.openVmSettings": "Local VM settings",
  "place.action.clearPin": "Clear this conversation's place",
  "place.action.usePlace": "Use {place}",
  "place.action.changeRoutine": "Change where it runs",
  "place.action.openComputerPanel": "Open Computer panel",
  "place.askAdmin": "Ask an Admin to change it.",
  "place.backOnAuto": "This conversation is back on Auto.",
} as const;
export type PlaceKey = keyof typeof PLACE_EN;

export const PLACE_WORDS: Record<PlaceActionId, string> = {
  "choose-model": "Choose another model in {bot}'s settings.",
  "allow-computer": "Let {bot} use the computer from the Computer panel.",
  "sign-in": "Sign in to {engine} in Settings.",
  start: "Start it from the Computer panel.",
  wake: "Wake it from the Computer panel.",
  watch: "Watch it from the Computer panel.",
  "see-plan": "See your plan on the Plan page.",
  "get-cloud": "Get later.dog Cloud in Settings → Computer.",
  "manage-computers": "Manage your cloud computers in Settings → Computer.",
  "try-again": "Try again.",
  "open-my-cloud": "Open My Cloud from the menu at the top of the sidebar.",
  "turn-on-browser": "Turn on the built-in browser in the Computer panel.",
  "open-vm-settings": "Check it in Settings → Computer.",
  "clear-pin": "Clear this conversation's place in the composer to continue.",
  "change-routine": "Change where this routine runs.",
  "open-computer-panel": "Check it in the Computer panel.",
};

export type PlaceTranslate = (key: PlaceKey, params?: Record<string, string | number>) => string;

function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

export const english: PlaceTranslate = (key, params) => fill(PLACE_EN[key], params);

const STATE: Record<PlaceState, { key: string; action: PlaceActionId | null }> = {
  auto: { key: "auto", action: null },
  "cc-cannot": { key: "ccCannot", action: "choose-model" },
  "cc-tools-off": { key: "ccToolsOff", action: "allow-computer" },
  "cc-sign-in": { key: "ccSignIn", action: "sign-in" },
  "cc-new": { key: "ccNew", action: "start" },
  "cc-starting": { key: "ccStarting", action: "watch" },
  "cc-waking": { key: "ccWaking", action: "watch" },
  "cc-on": { key: "ccOn", action: "watch" },
  "cc-asleep": { key: "ccAsleep", action: "wake" },
  "cc-no-hours": { key: "ccNoHours", action: "see-plan" },
  "cc-at-once": { key: "ccAtOnce", action: "manage-computers" },
  "cc-trial-one": { key: "ccTrialOne", action: "get-cloud" },
  "cc-unavailable": { key: "ccUnavailable", action: "try-again" },
  "cc-ended": { key: "ccEnded", action: "see-plan" },
  "cc-no-start": { key: "ccNoStart", action: "try-again" },
  "cc-clearing": { key: "ccClearing", action: "try-again" },
  "cc-provider": { key: "ccProvider", action: "try-again" },
  "cc-on-my-cloud": { key: "ccOnMyCloud", action: "open-my-cloud" },
  "cc-needs-key": { key: "ccNeedsKey", action: null },
  vps: { key: "vps", action: null },
  browser: { key: "browser", action: null },
  "browser-off": { key: "browserOff", action: "turn-on-browser" },
  "browser-cannot": { key: "browserCannot", action: "choose-model" },
  local: { key: "local", action: null },
  "local-unavailable": { key: "localUnavailable", action: null },
  vm: { key: "vm", action: "open-vm-settings" },
  "vm-cannot": { key: "vmCannot", action: "choose-model" },
  "place-failed": { key: "placeFailed", action: "open-computer-panel" },
  off: { key: "off", action: null },
};

const PASSING: ReadonlySet<PlaceState> = new Set(["cc-unavailable", "cc-no-start", "cc-clearing", "cc-provider", "place-failed"]);

const ADMIN_ONLY: ReadonlySet<PlaceActionId> = new Set([
  "choose-model", "allow-computer", "sign-in", "see-plan", "get-cloud", "manage-computers", "open-my-cloud",
  "turn-on-browser", "open-vm-settings", "change-routine",
]);
const ADMIN_SHORTCUT: ReadonlySet<PlaceActionId> = new Set(["start", "wake"]);

const ACTION_KEY: Record<PlaceActionId, PlaceKey> = {
  "choose-model": "place.action.chooseModel",
  "allow-computer": "place.action.allowComputer",
  "sign-in": "place.action.signIn",
  start: "place.action.start",
  wake: "place.action.wake",
  watch: "place.action.watch",
  "see-plan": "place.action.seePlan",
  "get-cloud": "place.action.getCloud",
  "manage-computers": "place.action.manageComputers",
  "try-again": "place.action.tryAgain",
  "open-my-cloud": "place.action.openMyCloud",
  "turn-on-browser": "place.action.turnOnBrowser",
  "open-vm-settings": "place.action.openVmSettings",
  "clear-pin": "place.action.clearPin",
  "change-routine": "place.action.changeRoutine",
  "open-computer-panel": "place.action.openComputerPanel",
};

export function placeState(facts: PlaceFacts): { state: PlaceState; params: PlaceParams } {
  const bot = facts.bot;
  const model = facts.engine.model || facts.engine.name;
  if (facts.place === "off") return { state: "off", params: { bot } };
  if (facts.place === "auto") return { state: "auto", params: { bot } };
  if (facts.place === "browser") {
    if (!facts.engine.browser) return { state: "browser-cannot", params: { bot, model } };
    return facts.browserOn ? { state: "browser", params: { bot } } : { state: "browser-off", params: { bot } };
  }
  if (facts.place === "local") {
    return facts.local?.ready === false
      ? { state: "local-unavailable", params: { bot, reason: facts.local.reason ?? "" } }
      : { state: "local", params: { bot } };
  }
  if (facts.place === "vm") {
    return facts.engine.computer ? { state: "vm", params: { bot } } : { state: "vm-cannot", params: { bot, model } };
  }
  const vps = facts.backend === "vps";
  if (!facts.engine.computer) return { state: "cc-cannot", params: { bot, model } };
  if (!facts.toolsAllowComputer) return { state: "cc-tools-off", params: { bot } };
  if (!facts.engine.signedIn) return { state: "cc-sign-in", params: { bot, engine: facts.engine.name } };
  if (vps) return { state: "vps", params: { bot } };
  if (facts.refusal) return { state: facts.refusal.state, params: { bot, ...facts.refusal.params } };
  if (facts.boat === "none") {
    if (facts.server === "my-cloud") return { state: "cc-unavailable", params: { bot } };
    return { state: facts.plan ? "cc-on-my-cloud" : "cc-needs-key", params: { bot } };
  }
  switch (facts.computer) {
    case "starting": return { state: "cc-starting", params: { bot } };
    case "waking": return { state: "cc-waking", params: { bot } };
    case "on": return { state: "cc-on", params: { bot } };
    case "asleep": return { state: "cc-asleep", params: { bot } };
    default: return { state: "cc-new", params: { bot } };
  }
}

function sourceAction(source: PlaceSource, state: PlaceState): PlaceActionId | null {
  switch (source) {
    case "works-on": return state === "place-failed" ? "open-computer-panel" : "try-again";
    case "auto-pin": return "try-again";
    case "pin": return "clear-pin";
    case "routine": return "change-routine";
    case "room": return null;
  }
}

function lineKey(state: PlaceState, params: PlaceParams, { server, reach }: PlaceContext): PlaceKey {
  const segment = STATE[state].key;
  if (state === "auto") return AUTO_LINE[reach ?? (server === "my-cloud" || server === "linux" ? "cloud" : "both")];
  if (state === "cc-sign-in" && server === "my-cloud") return "place.view.ccSignIn.lineMyCloud";
  if (state === "cc-no-hours" && (params.hours === undefined || !params.month)) return "place.view.ccNoHours.lineUnknown";
  if (state === "cc-trial-one") return params.holders?.length ? "place.view.ccTrialOne.line" : "place.view.ccTrialOne.lineUnknown";
  if (state === "cc-at-once") {
    if (!params.holders?.length || !params.plan || params.max === undefined) return "place.view.ccAtOnce.lineUnknown";
    return params.max === 1 ? "place.view.ccAtOnce.lineOne" : "place.view.ccAtOnce.lineMany";
  }
  return `place.view.${segment}.line` as PlaceKey;
}

export function listNames(names: readonly string[], locale = "en"): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

function templateParams(params: PlaceParams, locale: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? listNames(value, locale) : value;
  }
  return out;
}

export interface PlaceContext {
  server?: ServerKind;
  reach?: AutoReach;
  role: "admin" | "user";
  source?: PlaceSource;
  worksOnLabel?: string;
  translate?: PlaceTranslate;
  locale?: string;
}

export function placeViewOf(state: PlaceState, params: PlaceParams, context: PlaceContext): PlaceView {
  const translate = context.translate ?? english;
  const values = templateParams(params, context.locale ?? "en");
  const segment = STATE[state].key;
  let line = translate(lineKey(state, params, context), values);
  let action: PlaceActionId | null = context.source && PASSING.has(state) ? sourceAction(context.source, state) : STATE[state].action;
  if (context.source && (action === "start" || action === "wake" || action === "watch")) action = null;
  if (context.source === "auto-pin") line = `${line} ${translate("place.backOnAuto")}`;
  if (action === "open-vm-settings") action = null;
  if (action && context.role === "user" && ADMIN_SHORTCUT.has(action)) action = null;
  if (action && context.role === "user" && ADMIN_ONLY.has(action)) {
    action = null;
    line = `${line} ${translate("place.askAdmin")}`;
  }
  const label = !action ? null
    : action === "clear-pin" && context.worksOnLabel
      ? translate("place.action.usePlace", { place: context.worksOnLabel })
      : translate(ACTION_KEY[action], values);
  return {
    state,
    params,
    short: translate(`place.view.${segment}.short` as PlaceKey, values),
    line,
    action: action && label ? { id: action, label } : null,
  };
}

export function placeView(facts: PlaceFacts, options: { translate?: PlaceTranslate; locale?: string } = {}): PlaceView {
  const { state, params } = placeState(facts);
  return placeViewOf(state, params, { server: facts.server, reach: autoReach(facts), role: facts.role, ...options });
}

function autoReach(facts: PlaceFacts): AutoReach {
  const cloud = facts.server === "my-cloud" || facts.boat !== "none";
  const local = (facts.server === "mac" || facts.server === "pc") && facts.local?.ready !== false;
  return cloud ? (local ? "both" : "cloud") : local ? "local" : "none";
}

export function placeRowView(row: PlaceRow, context: Omit<PlaceContext, "source">): PlaceView {
  return placeViewOf(row.state, row.params, { ...context, source: row.source });
}

export function placeRowText(row: PlaceRow, server?: ServerKind): string {
  const view = placeViewOf(row.state, row.params, { server, role: "admin", source: row.source });
  if (!view.action) return view.line;
  const words = row.source === "auto-pin" && view.action.id === "try-again"
    ? "Send your message again."
    : fill(PLACE_WORDS[view.action.id], templateParams(row.params, "en"));
  return `${view.line} ${words}`;
}

const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December)";
const HOURS_USED = new RegExp(`Your (.+?) plan's (\\d+) cloud computer hours for \\w+ are used up\\. They reset on 1 ${MONTH}`);
const AT_ONCE = /Your (.+?) plan includes (\d+) cloud computers? at once/;
const PASSING_WORDS = [
  /cloud computers are busy right now/i, /temporarily unavailable/i, /can't be checked right now/i, /could not be reached/i,
  /returned an unexpected answer/i, /could not complete that request/i, /started too often/i, /woken too often/i,
  /included with your Cloud plan aren't available/i, /are not available right now/i, /fetch failed/i, /ECONNREFUSED/,
  /rate-limiting/i, /\b50[234]\b/,
];
const NO_START_WORDS = [
  /did not become ready/i, /desktop link could not be created/i, /could not be created or reached/i, /did not wake/i,
  /no computer yet/i, /didn't start in time/i,
];
const CLEARING_WORDS = [/is being deleted/i, /previous cloud computer deletion/i, /deletion was not confirmed/i, /deletion is still being reconciled/i];

export function cloudRefusal(failure: { message: string; code?: string; status?: number }, included: boolean): { state: PlaceState; params: PlaceParams } {
  const message = failure.message.trim();
  const code = failure.code;
  const hours = HOURS_USED.exec(message);
  if (code === "hours_used" || hours) {
    return { state: "cc-no-hours", params: hours ? { plan: hours[1], hours: Number(hours[2]), month: hours[3] } : {} };
  }
  if (code === "trial_one_computer" || /free trial (?:has|includes) one (?:cloud )?computer/i.test(message)) return { state: "cc-trial-one", params: {} };
  const atOnce = AT_ONCE.exec(message);
  if (code === "at_once" || atOnce) {
    return { state: "cc-at-once", params: atOnce ? { plan: atOnce[1], max: Number(atOnce[2]) } : {} };
  }
  if (code === "subscription_inactive") return { state: "cc-ended", params: {} };
  if (code === "too_many_starts" || code === "rate_limited" || code === "usage_unavailable" || code === "service_unavailable"
    || code === "upstream_unavailable" || code === "invalid_response" || code === "upstream_error") {
    return { state: "cc-unavailable", params: {} };
  }
  if (NO_START_WORDS.some((words) => words.test(message))) return { state: "cc-no-start", params: {} };
  if (CLEARING_WORDS.some((words) => words.test(message))) return { state: "cc-clearing", params: {} };
  if ((failure.status ?? 0) >= 500 || PASSING_WORDS.some((words) => words.test(message))) return { state: "cc-unavailable", params: {} };
  if (!included && message) return { state: "cc-provider", params: { words: message.replace(/[\s.]+$/, "") + "." } };
  return { state: "cc-no-start", params: {} };
}
