
export interface OnboardingStatus {
  completedAt: string;
  version: number;
  reelSeen: boolean;
  hintsSeen: string[];
  firstTurnAt?: string;
}

export const WELCOME_VERSION = 2;

export const EMPTY_ONBOARDING: OnboardingStatus = {
  completedAt: "",
  version: 0,
  reelSeen: false,
  hintsSeen: [],
};

export interface WelcomeViewer {
  hosted: boolean;
  canSave: boolean;
  cloudHome?: boolean;
}

export const LOCAL_VIEWER: WelcomeViewer = { hosted: false, canSave: true };

export function hostedMember(viewer: WelcomeViewer | null): boolean {
  return Boolean(viewer?.hosted && !viewer.canSave);
}

export function spotlightsQuiet(viewer: WelcomeViewer | null): boolean {
  return viewer === null || hostedMember(viewer);
}

export function welcomeViewer(session: unknown): WelcomeViewer {
  const record = session && typeof session === "object" ? (session as { hosted?: unknown; scopes?: unknown; cloudHome?: unknown }) : {};
  return {
    hosted: record.hosted === true,
    canSave: Array.isArray(record.scopes) ? record.scopes.includes("admin") : true,
    ...(record.cloudHome === true ? { cloudHome: true } : {}),
  };
}

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
  if (!record.completedAt && options.legacyDone) return false;
  return true;
}

export function completionPatch(now: Date = new Date()): { onboarding: { completedAt: string; version: number } } {
  return { onboarding: { completedAt: now.toISOString(), version: WELCOME_VERSION } };
}

export function hintSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return (record?.hintsSeen ?? []).includes(id);
}

export function hintSeenPatch(
  record: OnboardingStatus | undefined,
  id: string,
): { onboarding: { hintsSeen: string[] } } | null {
  if (hintSeen(record, id)) return null;
  return { onboarding: { hintsSeen: [...(record?.hintsSeen ?? []), id] } };
}

export type BeatId = "hello" | "reel" | "engines" | "permissions" | "bot";

export interface BeatOptions {
  desktop: boolean;
  reel: boolean;
  hosted?: boolean;
}

export function beatsFor(options: BeatOptions): BeatId[] {
  if (options.hosted) return ["hello", "bot"];
  const beats: BeatId[] = ["hello"];
  if (options.reel) beats.push("reel");
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

export function beatWidth(beat: BeatId): number {
  switch (beat) {
    case "engines":
      return 520;
    case "reel":
      return 720;
    case "bot":
      return 520;
    default:
      return 460;
  }
}

export function flowDotsShown(beat: BeatId): boolean {
  return beat !== "reel";
}

export function defaultAdminOrigin(bridge: { defaultPortalOrigin?: string } | undefined): string | null {
  const value = bridge?.defaultPortalOrigin?.trim();
  return value ? value : null;
}

export function organisationSignIn<Bridge>(
  laterdog: { organization?: Bridge; remoteClient?: { active?: boolean } } | undefined,
  options: { hosted: boolean },
): Bridge | undefined {
  if (options.hosted || !laterdog || laterdog.remoteClient?.active === true) return undefined;
  return laterdog.organization;
}

export function companyModelCount(state: { providers?: Array<{ configured: boolean; models: string[] }> } | null): number {
  return (state?.providers ?? []).reduce((total, provider) => total + (provider.configured ? provider.models.length : 0), 0);
}

interface SummaryInstance {
  install?: unknown;
  managed?: unknown;
}

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

const ONBOARDING_ACCOUNTS = [
  { id: "claude", driverKind: "claudeAgent", primary: "claude", method: "paste-code" },
  { id: "chatgpt", driverKind: "codex", primary: "chatgpt", method: "browser-pkce" },
] as const;
export type OnboardingAccountId = (typeof ONBOARDING_ACCOUNTS)[number]["id"];
export const ONBOARDING_ACCOUNT_IDS: readonly OnboardingAccountId[] = ONBOARDING_ACCOUNTS.map((account) => account.id);

interface AccountInstance {
  instanceId: string;
  driverKind: string;
  access?: string;
  readOnly?: boolean;
  managed?: unknown;
  policy?: unknown;
  snapshot: { state: string; authenticationUnavailableReason?: string };
  authentication?: { method: string };
  install?: { server?: unknown };
}

export type OnboardingAccount = { id: OnboardingAccountId } & (
  | { status: "ready" | "unavailable" }
  | { status: "signIn"; instanceId: string; install: boolean }
);

export function onboardingAccounts<Instance extends AccountInstance>(
  instances: readonly Instance[],
  ready: (instance: Instance) => boolean,
): OnboardingAccount[] {
  return ONBOARDING_ACCOUNTS.map(({ id, driverKind, primary, method }): OnboardingAccount => {
    const own = instances.filter((instance) => instance.driverKind === driverKind && !instance.managed && !instance.policy && !instance.readOnly);
    if (own.some(ready)) return { id, status: "ready" };
    const targets = own.filter((instance) => instance.authentication?.method === method
      && (instance.access ?? "subscription") === "subscription" && !instance.snapshot.authenticationUnavailableReason);
    const target = targets.find((instance) => instance.instanceId === primary) ?? targets[0];
    const installed = target?.snapshot.state === "available";
    if (!target || (!installed && !target.install?.server)) return { id, status: "unavailable" };
    return { id, status: "signIn", instanceId: target.instanceId, install: !installed };
  });
}

export function cloudSignInDue<Instance>(
  viewer: WelcomeViewer | null,
  state: { connected: boolean; instances: readonly Instance[] },
  ready: (instance: Instance) => boolean,
): boolean {
  return Boolean(viewer?.cloudHome && viewer.canSave) && state.connected && state.instances.length > 0 && !state.instances.some(ready);
}

export function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true") return true;
  return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
