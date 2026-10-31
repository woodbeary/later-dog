import { NearbyPlacesError, nearbyPlaces, type LookupFetch } from "../laterdog/nearby-places.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const NEARBY_PLACES_PATH = "/api/internal/nearby-places";

export interface NearbyPlacesRouteDeps {
  active(capability: unknown): boolean;
  fetch: LookupFetch;
  overpassUrl?: string;
  geocodeUrl?: string;
}

export function createNearbyPlacesRoute(deps: NearbyPlacesRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability }) => {
    if (method !== "POST" || path !== NEARBY_PLACES_PATH) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    try {
      return json(res, 200, await nearbyPlaces(await readBody(), { fetch: deps.fetch, overpassUrl: deps.overpassUrl, geocodeUrl: deps.geocodeUrl }));
    } catch (error) {
      if (error instanceof NearbyPlacesError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
