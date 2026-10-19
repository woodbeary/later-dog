
import type { Surface } from "../shared/wire.ts";
import { canWorkOnCloud, type CloudEngine } from "../shared/cloud-computer.ts";
import { canUseMcpServer } from "../shared/tool-scope.ts";
import { placeRowText, type PlaceRow, type PlaceSource } from "../shared/place-view.ts";
import { offersPlace } from "../shared/places.ts";
export type { Surface, PlaceSource };

export type Destination = Surface | "off" | undefined;

export type ComputerWant = "cloud" | "vm" | "local" | "off" | undefined;

export interface MountedSurfaces {
  computer: Surface | null;
  browser: boolean;
}

export interface SurfacePlan {
  computer: ComputerWant;
  browser: boolean;
  pinned: Surface | null;
  note: string;
}

const SURFACES: ReadonlySet<string> = new Set(["cloud", "vm", "local", "browser"]);

export function parseSurface(value: unknown): Surface | undefined {
  return typeof value === "string" && SURFACES.has(value) ? (value as Surface) : undefined;
}

export function surfaceOfComputerKind(kind: "box" | "vps" | "vm" | "local" | null): Surface | null {
  if (kind === "box" || kind === "vps") return "cloud";
  return kind;
}

const OFF_NOTE =
  " This bot's \"Works on\" setting is Off, so no computer is mounted this turn: you cannot open a page, click, or type on any screen. If the user asks for something that needs one, tell them Works on is Off in this bot's settings — never claim you are opening a browser you do not have.";

export function resolveSurface(input: {
  destination: Destination;
  pinnedSurface?: Surface | null;
  browserOn: boolean;
}): SurfacePlan {
  const { destination, browserOn } = input;
  if (destination === "off") {
    return { computer: "off", browser: false, pinned: null, note: OFF_NOTE };
  }
  const pin = offersPlace(input.pinnedSurface) ? input.pinnedSurface : null;
  if (pin) return { computer: pin, browser: false, pinned: pin, note: "" };
  if (offersPlace(destination)) return { computer: destination, browser: false, pinned: null, note: "" };
  return { computer: undefined, browser: browserOn, pinned: null, note: "" };
}

export function cloudPlaceRefusal(engine: CloudEngine & { name: string }, source: PlaceSource, bot: string): PlaceUnavailableError | null {
  if (canWorkOnCloud(engine)) return null;
  return placeUnavailable("cloud", { state: "cc-cannot", params: { bot, model: engine.name }, source });
}

export function computerToolsRefusal(toolScope: unknown, source: PlaceSource, bot: string): PlaceUnavailableError | null {
  if (canUseMcpServer(toolScope, "computer")) return null;
  return placeUnavailable("cloud", { state: "cc-tools-off", params: { bot }, source });
}

export class PlaceUnavailableError extends Error {
  readonly place: Surface;
  readonly row: PlaceRow;
  constructor(place: Surface, row: PlaceRow, cloudHome = false) {
    super(placeRowText(row, cloudHome ? "my-cloud" : undefined));
    this.name = "PlaceUnavailableError";
    this.place = place;
    this.row = row;
  }
}

export function placeUnavailable(place: Surface, row: PlaceRow, cloudHome = false): PlaceUnavailableError {
  return new PlaceUnavailableError(place, row, cloudHome);
}

export function surfaceLabel(surface: Surface): string {
  switch (surface) {
    case "cloud":
      return "the cloud computer";
    case "vm":
      return "the Local VM";
    case "local":
      return "this computer";
    case "browser":
      return "the built-in browser";
  }
}

const RESTATE_SENTENCE =
  " Before your first action on a screen or page in a task, say in one short sentence where you are working, using that same name.";

const ASK_TO_SWITCH = "say so plainly";

const SURFACE_AUTHORITY =
  ` For screen tasks, use later.dog's mounted computer tools first: inspect the target, perform the action, and verify its result before claiming success. Discover deferred tools by their server/name when needed. Do not substitute the provider's own desktop, a shell-launched browser, or another automation path for the selected later.dog computer. Ordinary code and file tasks may still use their normal tools. Announcing an action is not performing it. A request naming another place does not move these tools: this computer is the user's own computer and the cloud computer is the dog's own computer in the cloud. If the requested place differs from the mounted one, ${ASK_TO_SWITCH}; never act on a different computer.`;

const CLOUD_HOME_WORDING: ReadonlyArray<readonly [string, string]> = [
  ["this computer is the user's own computer and the cloud computer is the dog's own computer in the cloud",
    "the cloud computer is the dog's own computer and the user's own computer cannot be reached from here"],
];

export function surfacePrompt(
  mounted: MountedSurfaces,
  opts: { note?: string; canSelect?: boolean; cloudHome?: boolean } = {},
): string {
  const computer = mounted.computer ? surfaceLabel(mounted.computer) : null;
  let text = "";
  if (computer && mounted.browser) {
    text =
      ` Two surfaces are mounted this turn: the built-in browser (the browser server's browser_navigate, browser_snapshot, browser_click, browser_fill and friends) and ${computer} (the computer server's tools). Web tasks → the built-in browser. Desktop apps, files and shell → ${computer} tools. Pick one surface for a task and stay on it; if you need the user to sign in, say which surface — the built-in browser or ${computer}.`;
  } else if (computer) {
    text =
      ` Everything you do on screen happens on ${computer}, web pages included, through its own browser. If you need the user to sign in, tell them it is on ${computer}.`;
  } else if (mounted.browser) {
    text =
      " Everything you do on screen happens in the built-in browser; there is no desktop, file or shell computer this turn. If you need the user to sign in, tell them it is in the built-in browser.";
  }
  if (text) text += RESTATE_SENTENCE + (opts.canSelect
    ? SURFACE_AUTHORITY.replace(ASK_TO_SWITCH, "inspect connected choices with select_computer and select the requested available place; on a pending result end this turn so later.dog can reconnect the correct tools and continue the original request")
    : SURFACE_AUTHORITY);
  else if (!opts.note && !opts.canSelect) {
    text = " No computer tools are mounted this turn. You cannot open apps, click, or inspect a screen through later.dog. If asked for screen work, say so plainly; do not claim to have opened or checked it.";
  }
  if (opts.canSelect) text += " For a screen task, use select_computer with no arguments when you need to inspect the actual available targets. Choose the requested place from its result; if the user left the place open, use a suitable available target or surface auto instead of asking them to operate the menu. Choose before taking actions, and do not repeat actions already completed if the task must continue elsewhere. later.dog can start an existing configured computer and highlight the selected target. If the right tools are already mounted, use them directly. On a pending switch, end this turn: the original request resumes automatically with the new tools, and then you must carry out the task. Only ask for input for a genuine blocker, such as missing setup, required sign-in or an approval.";
  if (opts.canSelect) text += " If no suitable computer is running but its provider is configured, select_computer can provision one for this computer task; reuse existing resources first. Do not provision merely for ordinary chat or inspection.";
  if (opts.canSelect && !computer && !mounted.browser) text += " No computer tools are mounted yet; select_computer is the way to connect them before screen work, not a reason to claim you already performed it.";
  if (computer || mounted.browser) text += " For online research, use the computer's browser when a search service is unavailable. A failed tool proves only that this attempt failed, not that every browser is unavailable. Inspect the current page after navigation; report a sign-in page, redirect or error as such. A completed model turn is not proof that the user's task succeeded.";
  if (opts.cloudHome) for (const [desktop, cloudHome] of CLOUD_HOME_WORDING) text = text.replace(desktop, cloudHome);
  return text + (opts.note ?? "");
}
