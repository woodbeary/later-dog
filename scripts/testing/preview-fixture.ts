import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface PreviewRoute {
  path: string | RegExp;
  method?: string;
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray | null) => void | Promise<void>;
}

export interface PreviewOptions {
  entry: string;
  route: string;
  title: string;
  extraRoutes?: PreviewRoute[];
  viewport?: string;
  logLevel?: "info" | "warn" | "error" | "silent";
}

export interface MountedPreview {
  previewUrl: string;
  close(): Promise<void>;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);

const matchRoute = (route: PreviewRoute, pathname: string, method: string | undefined) => {
  if (route.method !== undefined && route.method !== method) return undefined;
  if (typeof route.path === "string") return route.path === pathname ? { match: null } : undefined;
  const match = route.path.exec(pathname);
  return match ? { match } : undefined;
};

export async function mountPreview(
  fixture: { info: { url: string } },
  options: PreviewOptions,
): Promise<MountedPreview> {
  const { entry, route, title, extraRoutes = [], viewport = "width=device-width, initial-scale=1", logLevel } = options;
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="${escapeHtml(viewport)}"><title>${escapeHtml(title)}</title></head><body><div id="root"></div><script type="module" src="${escapeHtml(entry)}"></script></body></html>`;
  const ui = await createServer({
    root: REPO_ROOT,
    ...(logLevel ? { logLevel } : {}),
    server: { host: "127.0.0.1", port: 0, proxy: {
      "/api": { target: fixture.info.url },
      "/.well-known/laterdog/environment": { target: fixture.info.url },
    } },
    plugins: [{
      name: "isolated-preview",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = (req.url ?? "").split("?")[0]!;
          if (pathname === route) {
            void server.transformIndexHtml(route, page)
              .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); })
              .catch(next);
            return;
          }
          for (const extra of extraRoutes) {
            const hit = matchRoute(extra, pathname, req.method);
            if (!hit) continue;
            void Promise.resolve().then(() => extra.handler(req, res, hit.match)).catch(next);
            return;
          }
          next();
        });
      },
    }],
  });
  await ui.listen();
  const base = ui.resolvedUrls?.local[0];
  if (!base) {
    await ui.close();
    throw new Error("the preview server did not report a local URL");
  }
  return {
    previewUrl: new URL(route, base).href,
    close: () => ui.close(),
  };
}

export function parkUntilSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = () => {
      process.off("SIGINT", settle);
      process.off("SIGTERM", settle);
      resolve();
    };
    process.once("SIGINT", settle);
    process.once("SIGTERM", settle);
  });
}

export interface FixtureApiOptions {
  headers?: Record<string, string>;
  observe?: (call: { method: string; path: string; status: number }) => void;
}

export function fixtureApi(baseUrl: string, options: FixtureApiOptions = {}) {
  return async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { "content-type": "application/json", ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
    options.observe?.({ method, path, status: response.status });
    return result;
  };
}
