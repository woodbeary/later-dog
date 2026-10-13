const asDirectory = (path: string) => (path.endsWith("/") ? path : `${path}/`);

export function protectedResourceFor(target: URL, advertised: unknown): string {
  const own = new URL(target);
  own.hash = "";
  if (typeof advertised !== "string" || own.origin === "null") return own.href;
  let resource: URL;
  try {
    resource = new URL(advertised);
  } catch {
    return own.href;
  }
  resource.hash = "";
  const covers = resource.origin === own.origin
    && !resource.username
    && !resource.password
    && !resource.search
    && asDirectory(own.pathname).startsWith(asDirectory(resource.pathname));
  return covers ? resource.href : own.href;
}
