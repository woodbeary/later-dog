export const APPLE_TEAM_ID = "5JAPUBC2B6";
export const PHONE_BUNDLE_ID = "dog.later.phone";
export const PHONE_APP_STORE_ID = "6822519577";
export const PHONE_APP_ID = `${APPLE_TEAM_ID}.${PHONE_BUNDLE_ID}`;
export const APP_SITE_ASSOCIATION_PATH = "/.well-known/apple-app-site-association";

export type AppSiteAssociationScope = "home" | "service";

type PathComponent = { "/": string; exclude?: true };

export interface AppSiteAssociation {
  applinks?: { details: { appIDs: string[]; components: PathComponent[] }[] };
  webcredentials: { apps: string[] };
}

const WEB_ONLY_HOME_PATHS = ["/api/*", "/hooks/*", "/.well-known/*", "/assets/*", "/pair", "/desktop-viewer", "/*.*"];

export function appSiteAssociation(scope: AppSiteAssociationScope): AppSiteAssociation {
  const webcredentials = { apps: [PHONE_APP_ID] };
  if (scope === "service") return { webcredentials };
  return {
    applinks: {
      details: [
        {
          appIDs: [PHONE_APP_ID],
          components: [...WEB_ONLY_HOME_PATHS.map((path): PathComponent => ({ "/": path, exclude: true })), { "/": "/*" }],
        },
      ],
    },
    webcredentials,
  };
}

const HEADERS = { "content-type": "application/json", "cache-control": "public, max-age=3600" };

export function appSiteAssociationResponse(request: Request, scope: AppSiteAssociationScope): Response | null {
  if (new URL(request.url).pathname !== APP_SITE_ASSOCIATION_PATH) return null;
  if (request.method === "GET") return new Response(JSON.stringify(appSiteAssociation(scope)), { headers: HEADERS });
  if (request.method === "HEAD") return new Response(null, { headers: HEADERS });
  return new Response("Use GET or HEAD.", { status: 405, headers: { allow: "GET, HEAD" } });
}
