import environments from "./environments.cjs";

export const CLOUD_HOME_NAME = "My Cloud";
export const CLOUD_MACHINE_STATUSES = Object.freeze(["provisioning", "ready", "stopped", "payment-problem", "failed"]);
export const CLOUD_MACHINE_CONNECTABLE = Object.freeze(["ready"]);
const ADMIN_STATES = Object.freeze({
  setting_up: "provisioning", ready: "ready", stopped: "stopped", payment_problem: "payment-problem", failed: "failed",
});
const CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const MAX_GRANT_MS = 10 * 60_000;

function homeOrigin(value) {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || value !== url.origin || !url.hostname.includes(".")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const CLOUD_SETUP_STEPS = Object.freeze(["reserving", "storage", "starting", "checking"]);
const GB = 1024 ** 3;
const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const moment = value => Number.isSafeInteger(value) && value > 0;
const wholeGb = value => Number.isSafeInteger(value) && value >= 1 && value <= 10_000;

export function parseCloudSummary(input) {
  if (!record(input)) return null;
  const status = Object.hasOwn(ADMIN_STATES, input.state) ? ADMIN_STATES[input.state] : null;
  if (!status) return null;
  const origin = input.origin === undefined || input.origin === null ? null : homeOrigin(input.origin);
  if ((input.origin !== undefined && input.origin !== null && !origin) || (CLOUD_MACHINE_CONNECTABLE.includes(status) && !origin)) return null;
  const setup = status === "provisioning" && record(input.setup) && CLOUD_SETUP_STEPS.includes(input.setup.step)
    ? { step: input.setup.step, ...(input.setup.slow === true ? { slow: true } : {}) } : null;
  const retryAt = status === "failed" && moment(input.retryAt) ? input.retryAt : null;
  const disk = record(input.disk) && wholeGb(input.disk.gb) && wholeGb(input.disk.maxGb) && input.disk.maxGb >= input.disk.gb
    ? { gb: input.disk.gb, maxGb: input.disk.maxGb } : null;
  return { status, ...(origin ? { origin } : {}), ...(setup ? { setup } : {}), ...(retryAt ? { retryAt } : {}), ...(disk ? { disk } : {}) };
}

const PURCHASE_STATES = Object.freeze(["confirming", "held"]);
const TIER = /^[a-z][a-z0-9-]{0,23}$/;
export function parseCloudPurchase(input) {
  if (!record(input) || !PURCHASE_STATES.includes(input.state)) return null;
  const tier = typeof input.plan === "string" && TIER.test(input.plan) ? input.plan : null;
  return { state: input.state, ...(tier ? { tier } : {}), ...(moment(input.paidAt) ? { paidAt: input.paidAt } : {}) };
}

const LARGEST_TIER = "max";
export function cloudPlanDisk(state) {
  if (state?.status !== "connected" || state.entitlement?.plan !== "pro") return null;
  const disk = state.machine?.disk;
  if (!disk) return null;
  return { volumeBytes: disk.gb * GB, maxBytes: disk.maxGb * GB, ...(state.entitlement.tier === LARGEST_TIER ? { largest: true } : {}) };
}

export function rememberedCloudHome(previous, state) {
  const accountId = state?.account?.id ?? null;
  if (!accountId) return null;
  if (state.status === "connected" && !state.machine) return null;
  const origin = state.status === "connected" ? state.machine.origin ?? null : null;
  if (origin) return { accountId, origin };
  return previous?.accountId === accountId ? previous : null;
}

export function myCloudOrigin({ account, remembered }) {
  if (!account) return null;
  const verified = account.homeTarget()?.origin;
  if (verified) return verified;
  const accountId = account.state()?.account?.id;
  return accountId && remembered?.accountId === accountId ? remembered.origin : null;
}

export function isCloudHomeEntry(entry, { homeOrigin = null, remembered = null } = {}) {
  return Boolean(entry?.origin) && (entry.origin === homeOrigin || entry.origin === remembered?.origin);
}

export function savedCloudHomeOrigin(state) {
  const saved = Array.isArray(state?.environments) ? state.environments : [];
  return saved.find((entry) => entry?.name === CLOUD_HOME_NAME)?.origin ?? null;
}

export function parsePairingGrant(input, origin, now) {
  if (!input || typeof input !== "object" || input.cloudContractVersion !== 1 || input.origin !== origin) return null;
  if (typeof input.code !== "string" || !CODE.test(input.code)) return null;
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + MAX_GRANT_MS) return null;
  return { origin, code: input.code, expiresAt: input.expiresAt };
}

export function withCloudHome(state, machine, makeId) {
  if (!machine?.origin || machine.status === "provisioning") return state;
  if (state.environments.some((entry) => entry.origin === machine.origin)) return state;
  return environments.withEnvironment(state, { origin: machine.origin, name: CLOUD_HOME_NAME }, makeId);
}

export function cloudHomeConnectUrl(target, now, open = null) {
  const query = open === "phone" ? "?desktop-settings=phone" : "";
  return target.grant && target.grant.origin === target.origin && target.grant.expiresAt > now
    ? `${target.origin}/pair${query}#code=${target.grant.code}` : query ? `${target.origin}/${query}` : target.origin;
}
