import type { IncomingMessage } from "node:http";
import { PHONE_APP_STORE_ID } from "../../shared/apple-app.ts";
import { isLoopbackHost, requestOrigin } from "../request-auth.ts";

const BANNER_TAG = /[ \t]*<meta\s+name="apple-itunes-app"[^>]*>\r?\n?/i;
const DESKTOP_APP = /\bElectron\//;

export interface PageVisit {
  cloudHome: boolean;
  host: string | undefined;
  origin: string | null;
  path: string;
  userAgent: string | undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function pageVisit(req: IncomingMessage, path: string, cloudHome: boolean): PageVisit {
  return {
    cloudHome,
    host: firstHeader(req.headers.host),
    origin: requestOrigin(req),
    path,
    userAgent: firstHeader(req.headers["user-agent"]),
  };
}

export function advertisesPhoneApp(visit: PageVisit): boolean {
  return visit.cloudHome && !isLoopbackHost(visit.host) && !DESKTOP_APP.test(visit.userAgent ?? "");
}

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function pageAddress(visit: PageVisit): string | null {
  if (!visit.origin) return null;
  const path = visit.path === "/index.html" ? "/" : visit.path;
  return `${visit.origin}${path}`.replace(/,/g, "%2C");
}

export function smartAppBanner(address: string | null): string {
  const content = address ? `app-id=${PHONE_APP_STORE_ID}, app-argument=${address}` : `app-id=${PHONE_APP_STORE_ID}`;
  return `<meta name="apple-itunes-app" content="${attribute(content)}" />`;
}

export function visitorPage(html: string, visit: PageVisit): string {
  if (!BANNER_TAG.test(html)) return html;
  if (!advertisesPhoneApp(visit)) return html.replace(BANNER_TAG, "");
  const indent = /([ \t]*)<meta\s+name="apple-itunes-app"/i.exec(html)?.[1] ?? "";
  return html.replace(BANNER_TAG, () => `${indent}${smartAppBanner(pageAddress(visit))}\n`);
}
