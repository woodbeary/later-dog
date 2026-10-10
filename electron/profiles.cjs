const MAIN_ID = "main";
const MAX_NAME = 40;
const MAX_PROFILES = 8;
const FIRST_PORT = 8811;
const LAST_PORT = 8899;
const ID_PATTERN = /^p[a-f0-9]{12}$/;

function cleanName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_NAME).trim() : "";
}

function validPort(port) {
  return Number.isInteger(port) && port >= FIRST_PORT && port <= LAST_PORT && (port - FIRST_PORT) % 2 === 0;
}

function emptyProfiles() {
  return { mainName: "", activeId: MAIN_ID, profiles: [] };
}

function parseProfiles(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return emptyProfiles();
  }
  if (!value || typeof value !== "object") return emptyProfiles();
  const list = Array.isArray(value.profiles) ? value.profiles : [];
  const ids = new Set([MAIN_ID]);
  const ports = new Set();
  const profiles = [];
  for (const entry of list) {
    if (profiles.length >= MAX_PROFILES - 1) break;
    const id = typeof entry?.id === "string" && ID_PATTERN.test(entry.id) ? entry.id : null;
    const name = cleanName(entry?.name);
    const port = entry?.port;
    if (!id || ids.has(id) || !name || !validPort(port) || ports.has(port)) continue;
    ids.add(id);
    ports.add(port);
    profiles.push({ id, name, port });
  }
  const activeId = profiles.some((profile) => profile.id === value.activeId) ? value.activeId : MAIN_ID;
  return { mainName: cleanName(value.mainName), activeId, profiles };
}

function serializeProfiles(state) {
  return JSON.stringify({ version: 1, mainName: state.mainName, activeId: state.activeId, profiles: state.profiles }, null, 2) + "\n";
}

function nextPort(state, unavailable = []) {
  const used = new Set([...state.profiles.map((profile) => profile.port), ...unavailable]);
  for (let port = FIRST_PORT; port <= LAST_PORT; port += 2) {
    if (!used.has(port)) return port;
  }
  return null;
}

function canAddProfile(state) {
  return state.profiles.length < MAX_PROFILES - 1 && nextPort(state) !== null;
}

function withProfile(state, name, makeId) {
  const clean = cleanName(name);
  if (!clean) throw new Error("A profile needs a name");
  if (!canAddProfile(state)) throw new Error(`You can have up to ${MAX_PROFILES} profiles`);
  const fresh = (candidate) => typeof candidate === "string" && ID_PATTERN.test(candidate) && !state.profiles.some((profile) => profile.id === candidate);
  let id = makeId();
  for (let tries = 1; !fresh(id); tries++) {
    if (tries >= 10) throw new Error("Could not name the new profile's folder");
    id = makeId();
  }
  const profile = { id, name: clean, port: nextPort(state) };
  return { state: { ...state, profiles: [...state.profiles, profile] }, profile };
}

function withName(state, id, name) {
  const clean = cleanName(name);
  if (id === MAIN_ID) return { ...state, mainName: clean };
  if (!clean || !state.profiles.some((profile) => profile.id === id)) return state;
  return { ...state, profiles: state.profiles.map((profile) => (profile.id === id ? { ...profile, name: clean } : profile)) };
}

function withoutProfile(state, id) {
  if (id === MAIN_ID || !state.profiles.some((profile) => profile.id === id)) return state;
  return {
    ...state,
    activeId: state.activeId === id ? MAIN_ID : state.activeId,
    profiles: state.profiles.filter((profile) => profile.id !== id),
  };
}

function withActive(state, id) {
  if (id !== MAIN_ID && !state.profiles.some((profile) => profile.id === id)) return state;
  return { ...state, activeId: id };
}

function withPort(state, id, port) {
  if (!validPort(port) || state.profiles.some((profile) => profile.id !== id && profile.port === port)) return state;
  return { ...state, profiles: state.profiles.map((profile) => (profile.id === id ? { ...profile, port } : profile)) };
}

function activeProfile(state) {
  return state.profiles.find((profile) => profile.id === state.activeId) ?? null;
}

function profileOrigin(profile) {
  return `http://127.0.0.1:${profile.port}`;
}

function profileList(state, status = () => "running") {
  return {
    activeId: state.activeId,
    canAdd: canAddProfile(state),
    profiles: [
      { id: MAIN_ID, name: state.mainName, main: true, status: "running" },
      ...state.profiles.map((profile) => ({ id: profile.id, name: profile.name, main: false, status: status(profile.id) })),
    ],
  };
}

module.exports = {
  FIRST_PORT,
  LAST_PORT,
  MAIN_ID,
  MAX_NAME,
  MAX_PROFILES,
  activeProfile,
  canAddProfile,
  cleanName,
  emptyProfiles,
  nextPort,
  parseProfiles,
  profileList,
  profileOrigin,
  serializeProfiles,
  validPort,
  withActive,
  withName,
  withPort,
  withProfile,
  withoutProfile,
};
