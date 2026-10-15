import { normalizeControlPlaneURL } from "./control-plane-client.mjs";

export const CONTROL_PLANE_URL_VARIABLES = ["LATERDOG_CONTROL_PLANE_URL"];

export function resolveControlPlaneURL({ environment = process.env } = {}) {
  for (const name of CONTROL_PLANE_URL_VARIABLES) {
    if (Object.hasOwn(environment, name)) return normalizeControlPlaneURL(environment[name]);
  }
  return "";
}
