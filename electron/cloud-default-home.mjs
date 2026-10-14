import { CLOUD_MACHINE_CONNECTABLE } from "./cloud-home.mjs";

export function readyHome(state) {
  const machine = state?.status === "connected" ? state.machine : undefined;
  return machine?.origin && CLOUD_MACHINE_CONNECTABLE.includes(machine.status) ? { origin: machine.origin } : null;
}

export function enterHomeNow({ state, activeOrigin, enteredOrigin }) {
  const home = readyHome(state);
  return Boolean(home) && activeOrigin !== home.origin && enteredOrigin !== home.origin;
}

export function leaveHomeNow({ state, homeEntry }) {
  if (state?.status !== "signed-out" || state.message === "restoring") return false;
  return Boolean(homeEntry);
}

export function hasCloudAccount(state) {
  return Boolean(state?.account);
}

export function showsServerMenu(state) {
  return !hasCloudAccount(state);
}

export function parseOffer(raw) {
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  const answered = value && typeof value === "object" && Number.isSafeInteger(value.answeredAt) ? value.answeredAt : null;
  return answered === null ? null : { answeredAt: answered, answer: value.answer === "signed-in" ? "signed-in" : "not-now" };
}

export function createCloudOffer({ read, write, now = Date.now }) {
  const answer = () => { try { return parseOffer(read()); } catch { return null; } };
  const record = choice => { write(`${JSON.stringify({ version: 1, answeredAt: now(), answer: choice })}\n`); };
  return {
    due: () => answer() === null,
    decline: () => { if (answer() === null) record("not-now"); },
    signedIn: () => { if (answer()?.answer !== "signed-in") record("signed-in"); },
  };
}
