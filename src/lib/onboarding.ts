// First-run state and the welcome flow's beat machine, kept pure so the
// decisions (show the tour? which beat is next? what to persist?) are unit
// tested without React. The record itself lives in the workspace config on
// the server, never in browser storage: clearing site data or opening a
// second profile must not replay the tour, and a phone paired later should
// see the same hints as already dismissed.

export interface OnboardingStatus {
  /** ISO timestamp; "" until the welcome flow has been finished or skipped. */
  completedAt: string;
  /** Which welcome flow was completed; a newer flow may re-show itself. */
  version: number;
  reelSeen: boolean;
  hintsSeen: string[];
  /** later.dog Cloud home only: when a bot's turn first finished there. The
   * server writes it (server/cloud-home.ts firstCloudTurnPatch). */
  firstTurnAt?: string;
}

/** Bump when the welcome flow changes enough that existing users should see
 * it again. Completions at an older version count as not done. */
export const WELCOME_VERSION = 2;

export const EMPTY_ONBOARDING: OnboardingStatus = {
  completedAt: "",
  version: 0,
  reelSeen: false,
  hintsSeen: [],
};

/** Who is opening the app, as far as first run cares. */
export interface WelcomeViewer {
  /** A hosted team workspace: its organisation's Admin assigns the models. */
  hosted: boolean;
  /** This session may write the workspace config. Finishing the welcome
   * flow is such a write, and `PUT /api/config` is admin-only. */
  canSave: boolean;
  /** A later.dog Cloud home (docs/cloud-pro.md): its first run is the engine
   * sign-in, not the welcome flow, which describes the person's computer. */
  cloudHome?: boolean;
}

/** The desktop app's own window talking to its own server: never hosted,
 * always the owner. Known without asking, so its first run never waits. */
export const LOCAL_VIEWER: WelcomeViewer = { hosted: false, canSave: true };

/** A hosted workspace's member. The workspace config is its admins', so no
 * first-run surface that writes it (the flow, the spotlights) is offered;
 * the member gets a note instead. Anywhere else a session without admin
 * scope is often the owner's own paired browser, and nothing is added. */
export function hostedMember(viewer: WelcomeViewer | null): boolean {
  return Boolean(viewer?.hosted && !viewer.canSave);
}

/** First-conversation spotlights wait for the viewer to be known, and never
 * show to a hosted member, who could not dismiss them for good. */
export function spotlightsQuiet(viewer: WelcomeViewer | null): boolean {
  return viewer === null || hostedMember(viewer);
}

/** Read `GET /api/auth/session` defensively. A server that sends no scopes
 * reads as today (the owner); one that predates `hosted` reads as not
 * hosted, which is also what it always was to the welcome flow. */
export function welcomeViewer(session: unknown): WelcomeViewer {
  const record = session && typeof session === "object" ? (session as { hosted?: unknown; scopes?: unknown; cloudHome?: unknown }) : {};
  return {
    hosted: record.hosted === true,
    canSave: Array.isArray(record.scopes) ? record.scopes.includes("admin") : true,
    ...(record.cloudHome === true ? { cloudHome: true } : {}),
  };
}

/** Whether the welcome flow should open on launch. Null config means the
 * server has not answered yet; showing the tour on a guess would flash it at
 * every returning user, so the answer is no until the record arrives.
 *
 * A session that cannot save the workspace config never gets it: it would
 * fail to save and come back on every visit. On a hosted workspace the tour
 * waits until the session is known to be an admin's. A Cloud home opens on
 * its engine sign-in instead (cloudSignInDue); the flow can still be replayed
 * from Settings. Callers that pass none of these fields keep the old answer. */
export function welcomeDue(
  config: { onboarding?: OnboardingStatus } | null | undefined,
  options: { remoteClient: boolean; legacyDone: boolean; hosted?: boolean; canSave?: boolean; cloudHome?: boolean },
): boolean {
  if (options.remoteClient || options.cloudHome) return false;
  if (options.canSave === false) return false;
  if (options.hosted && options.canSave !== true) return false;
  if (!config) return false;
  const record = config.onboarding ?? EMPTY_ONBOARDING;
  if (record.completedAt && record.version >= WELCOME_VERSION) return false;
  // One release of grace for installs that finished the old localStorage
  // gate: they are not new, so they are not shown the new flow either.
  if (!record.completedAt && options.legacyDone) return false;
  return true;
}

/** The config patch that marks the welcome flow done. Sent through the same
 * `PUT /api/config` path as the profile; sections merge server-side, so
 * hints already seen survive a replay. */
export function completionPatch(now: Date = new Date()): { onboarding: { completedAt: string; version: number } } {
  return { onboarding: { completedAt: now.toISOString(), version: WELCOME_VERSION } };
}

export function hintSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return (record?.hintsSeen ?? []).includes(id);
}

/** Null when nothing needs saving, so callers never issue a no-op write. */
export function hintSeenPatch(
  record: OnboardingStatus | undefined,
  id: string,
): { onboarding: { hintsSeen: string[] } } | null {
  if (hintSeen(record, id)) return null;
  return { onboarding: { hintsSeen: [...(record?.hintsSeen ?? []), id] } };
}

// ── beats ──────────────────────────────────────────────────────────────

export type BeatId = "hello" | "reel" | "engines" | "permissions" | "phone" | "bot";

export interface BeatOptions {
  /** The desktop app's own window, whose bridge can read and ask for this
   * computer's permissions; a browser, and a remote server's page, cannot.
   * First run no longer lists permissions, so this only describes the page. */
  desktop: boolean;
  /** The feature reel ships in a later phase; it is a beat the machine
   * already knows so that turning it on is one flag. */
  reel: boolean;
  /** A hosted team workspace: nothing is installed or granted on this
   * computer, and there is no phone to pair to it. */
  hosted?: boolean;
}

/** Beats in order for this session. The exit beat is always last so the
 * seeded bot is named even when everything else was skipped. A hosted
 * workspace gets a greeting and the bot: its organisation assigns the models,
 * and the reel, engines, permissions and phone beats all describe this
 * computer, which a hosted workspace is not. */
export function beatsFor(options: BeatOptions): BeatId[] {
  if (options.hosted) return ["hello", "bot"];
  const beats: BeatId[] = ["hello"];
  if (options.reel) beats.push("reel");
  beats.push("engines");
  beats.push("bot");
  return beats;
}

export function nextBeat(beats: readonly BeatId[], current: BeatId): BeatId | null {
  const index = beats.indexOf(current);
  if (index < 0 || index + 1 >= beats.length) return null;
  return beats[index + 1]!;
}

export function previousBeat(beats: readonly BeatId[], current: BeatId): BeatId | null {
  const index = beats.indexOf(current);
  if (index <= 0) return null;
  return beats[index - 1]!;
}

/** The card is one element for the whole flow; its width is the one thing
 * that morphs between beats. Engines lays tiles out two across and needs
 * the room; the rest read best narrow. */
export function beatWidth(beat: BeatId): number {
  switch (beat) {
    case "engines":
      return 680;
    case "phone":
      return 620;
    case "reel":
      return 720;
    case "bot":
      return 520;
    default:
      return 460;
  }
}

/** The footer's step dots. The reel beat draws its own scene dots (six,
 * clickable) just above the footer, and two rows of dots with different
 * counts read as one broken progress bar, so the reel keeps only its own;
 * the footer still says "Step 2 of 5". */
export function flowDotsShown(beat: BeatId): boolean {
  return beat !== "reel";
}

// ── engines and organisation sign-in ───────────────────────────────────

export function defaultAdminOrigin(bridge: { defaultPortalOrigin?: string } | undefined): string | null {
  const value = bridge?.defaultPortalOrigin?.trim();
  return value ? value : null;
}

/** The organisation sign-in bridge, when this window may offer it. Only the
 * packaged local desktop has one; a desktop acting as a remote client of
 * another server, a browser and a hosted workspace never do. */
export function organisationSignIn<Bridge>(
  laterdog: { organization?: Bridge; remoteClient?: { active?: boolean } } | undefined,
  options: { hosted: boolean },
): Bridge | undefined {
  if (options.hosted || !laterdog || laterdog.remoteClient?.active === true) return undefined;
  return laterdog.organization;
}

/** How many models the organisation approved for this computer. */
export function companyModelCount(state: { providers?: Array<{ configured: boolean; models: string[] }> } | null): number {
  return (state?.providers ?? []).reduce((total, provider) => total + (provider.configured ? provider.models.length : 0), 0);
}

interface SummaryInstance {
  install?: unknown;
  /** Set on Company instances: the organisation this desktop signed in to. */
  managed?: unknown;
}

/** What the engines beat counts. Personal engines are the rows; Company
 * instances have nothing to install and are not rows, but one that is signed
 * in means bots can run, so an employee with only company models has nothing
 * left to set up. `company` is off wherever organisation sign-in is not
 * offered, which keeps those counts exactly as they were. */
export function engineSummary<Instance extends SummaryInstance>(
  instances: readonly Instance[],
  ready: (instance: Instance) => boolean,
  options: { company: boolean },
): { ready: Instance[]; setup: Instance[]; company: number; allReady: boolean } {
  const engines = instances.filter((instance) => instance.install);
  const personal = engines.filter(ready);
  const setup = engines.filter((instance) => !ready(instance));
  const company = options.company ? instances.filter((instance) => instance.managed && ready(instance)).length : 0;
  return { ready: personal, setup, company, allReady: company > 0 || (personal.length > 0 && setup.length === 0) };
}

/** The products first run leads with, in order, and the drivers behind each. Codex has two routes (the CLI sign-in and
 * the ChatGPT plan) that a person thinks of as one product. */
const ONBOARDING_PRODUCTS = [
  { id: "claude", kinds: ["claudeAgent"], primary: "claude" },
  { id: "codex", kinds: ["codex"], primary: "codex" },
  { id: "cursor", kinds: ["cursorAgent"], primary: "cursor" },
  { id: "openaiCompat", kinds: ["openai-compat"], primary: "openaiCompat" },
] as const;
export type OnboardingProductId = (typeof ONBOARDING_PRODUCTS)[number]["id"];

interface ProviderInstance { instanceId: string; driverKind: string; displayName: string; managed?: unknown }
export interface OnboardingProvider<Instance extends ProviderInstance = ProviderInstance> {
  /** A product id for the featured four, else the instance id. */
  id: string;
  /** The instance this row signs in to or shows; null when the build has none for the product. */
  instance: Instance | null;
  /** Set for an engine outside the four: its own display name. */
  name?: string;
}

/** First run's provider rows: the four products (each backed by its ready instance, else its default one), every
 * other engine that already works, and the names of the rest as "coming soon". Company instances are not rows. */
export function onboardingProviders<Instance extends ProviderInstance>(
  instances: readonly Instance[],
  ready: (instance: Instance) => boolean,
): { featured: OnboardingProvider<Instance>[]; working: OnboardingProvider<Instance>[]; comingSoon: string[] } {
  const personal = instances.filter((instance) => !instance.managed);
  const featuredKinds = new Set<string>(ONBOARDING_PRODUCTS.flatMap((product) => product.kinds));
  const featured = ONBOARDING_PRODUCTS.map((product) => {
    const candidates = personal.filter((instance) => (product.kinds as readonly string[]).includes(instance.driverKind));
    const instance = candidates.find(ready) ?? candidates.find((candidate) => candidate.instanceId === product.primary) ?? candidates[0] ?? null;
    return { id: product.id, instance };
  // a product this build has no engine for would be a row with nothing to press
  }).filter((product) => product.instance !== null);
  const others = personal.filter((instance) => !featuredKinds.has(instance.driverKind));
  const working = others.filter(ready).map((instance) => ({ id: instance.instanceId, instance, name: instance.displayName }));
  const waiting = [...new Set(others.filter((instance) => !ready(instance)).map((instance) => instance.displayName))];
  const comingSoon = waiting.length > 6 ? [...waiting.slice(0, 6), `+${waiting.length - 6}`] : waiting;
  return { featured, working, comingSoon };
}

/** Whether a Cloud home shows its engine sign-in in place of a chat: the
 * person connected from the desktop app (an admin session), and nothing there
 * can run a bot yet. The default bot then shows the sign-in card rather than
 * failing its first turn. Like the no-engines screen, this waits for the
 * first /api/instances answer rather than flashing on a guess. */
export function cloudSignInDue<Instance>(
  viewer: WelcomeViewer | null,
  state: { connected: boolean; instances: readonly Instance[] },
  ready: (instance: Instance) => boolean,
): boolean {
  return Boolean(viewer?.cloudHome && viewer.canSave) && state.connected && state.instances.length > 0 && !state.instances.some(ready);
}

// ── motion ─────────────────────────────────────────────────────────────

/** The OS preference, plus a dev hook the preview page uses to show the
 * reduced variant without changing system settings. */
export function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true") return true;
  return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
