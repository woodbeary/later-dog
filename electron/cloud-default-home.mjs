export function leaveHomeNow({ state, homeEntry }) {
  if (state?.status !== "signed-out" || state.message === "restoring") return false;
  return Boolean(homeEntry);
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
