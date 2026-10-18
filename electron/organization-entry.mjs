import environments from "./environments.cjs";
import { deepLink, variant } from "./app-variant.mjs";

export const ORGANIZATION_DEEP_LINK = deepLink(variant, "organization");
const RESTART_FIELD = "desktopOrganizationSettingsPending";

export const isOrganizationDeepLink = value => value === ORGANIZATION_DEEP_LINK;
export function takeOrganizationDeepLink(argv) {
  let found = false;
  for (let index = argv.length - 1; index >= 0; index--) {
    if (!isOrganizationDeepLink(argv[index])) continue;
    argv.splice(index, 1);
    found = true;
  }
  return found;
}
export const organizationRestartIntent = credentials => credentials?.[RESTART_FIELD] === true;
export function withoutOrganizationRestartIntent(credentials) {
  const next = { ...credentials };
  delete next[RESTART_FIELD];
  return next;
}

export function createOrganizationEntry({ readState, confirm, saveEnvironments, clearRestartIntent, openLocalSettings }) {
  let pending = null;
  const identity = state => state.environments.activeId;

  async function enter() {
    const before = readState();
    const beforeIdentity = identity(before);
    const remote = environments.activeEnvironment(before.environments);
    if (remote) {
      const accepted = await confirm({ name: remote.name, origin: remote.origin });
      if (!accepted) return false;
      if (identity(readState()) !== beforeIdentity) throw new Error("The selected server changed. Choose organization sign-in again.");
      await saveEnvironments(environments.withActive(readState().environments, environments.LOCAL_ID));
    }
    await openLocalSettings();
    return true;
  }

  return {
    request() {
      if (!pending) pending = enter().finally(() => { pending = null; });
      return pending;
    },
    async restore() {
      const state = readState();
      if (!state.restartIntent) return false;
      await saveEnvironments(environments.withActive(state.environments, environments.LOCAL_ID));
      await openLocalSettings();
      return true;
    },
    async settingsOpened() {
      const state = readState();
      if (!state.restartIntent || environments.activeEnvironment(state.environments)) return false;
      await clearRestartIntent();
      return true;
    },
  };
}
