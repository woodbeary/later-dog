import { appLinkLogLabel } from "./app-link.mjs";

export async function openExternalLogged({ open, target, raw, log }) {
  let url;
  try {
    url = String(target());
  } catch (error) {
    log(`external open failed: ${appLinkLogLabel(raw)} refused`);
    throw error;
  }
  try {
    return await open(url);
  } catch (error) {
    log(`external open failed: ${appLinkLogLabel(url)} not opened`);
    throw error;
  }
}
