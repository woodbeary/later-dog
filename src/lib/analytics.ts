import type { PostHog } from "posthog-js";
import { ANALYTICS_TOKEN as TOKEN, analyticsConfigured } from "./laterdog-analytics";

export { analyticsConfigured };

const OPT_OUT_KEY = "laterdog-analytics-opt-out";

let client: PostHog | undefined;
let loading: Promise<void> | undefined;
let pending: Array<(ph: PostHog) => void> = [];

let choice: boolean | undefined;

export function analyticsEnabled(): boolean {
  if (!analyticsConfigured()) return false;
  if (choice !== undefined) return choice;
  try {
    return localStorage.getItem(OPT_OUT_KEY) !== "1";
  } catch {
    return true;
  }
}

export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(enabled: boolean, running: boolean): OptAction {
  if (!enabled) return running ? "opt-out" : "none";
  return running ? "opt-in" : "init";
}

export function setAnalyticsEnabled(enabled: boolean) {
  choice = enabled;
  try {
    localStorage.setItem(OPT_OUT_KEY, enabled ? "0" : "1");
  } catch {}
  if (!enabled) pending = [];
  switch (optAction(enabled, client !== undefined)) {
    case "opt-out":
      client?.opt_out_capturing();
      break;
    case "opt-in":
      client?.opt_in_capturing();
      break;
    case "init":
      void initAnalytics();
      break;
    case "none":
      break;
  }
}

export function initAnalytics(): Promise<void> {
  if (client || !analyticsEnabled()) return Promise.resolve();
  loading ??= import("posthog-js")
    .then(({ default: posthog }) => start(posthog))
    .catch(() => {
      pending = [];
    })
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

function start(posthog: PostHog) {
  if (!analyticsEnabled()) {
    pending = [];
    return;
  }
  posthog.init(TOKEN, {
    api_host: "https://us.i.posthog.com",
    autocapture: false,
    capture_pageview: false,
    person_profiles: "identified_only",
    persistence: "localStorage",
    disable_surveys: true,
  });
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
  client = posthog;
  const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
  if (!localStorage.getItem("laterdog-installed")) {
    localStorage.setItem("laterdog-installed", new Date().toISOString());
    posthog.capture("app_first_open", { platform });
  }
  posthog.capture("app_opened", { platform });
  for (const call of pending.splice(0)) call(posthog);
}

function whenReady(call: (ph: PostHog) => void) {
  if (!analyticsEnabled()) return;
  if (client) call(client);
  else if (loading) pending.push(call);
}

export function track(event: string, props?: Record<string, unknown>) {
  whenReady((ph) => ph.capture(event, props));
}

export function identifyEmail(email: string) {
  whenReady((ph) => {
    ph.identify(email, { email });
    ph.capture("email_submitted");
  });
}

const GATE_KEY = "laterdog-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
