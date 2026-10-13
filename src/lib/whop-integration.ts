export const WHOP_MCP_URL = "https://mcp.whop.com/mcp";

export function isWhopServer(server: { url?: string; type?: string }): boolean {
  if (server.type !== "http" || !server.url) return false;
  try {
    const url = new URL(server.url);
    return url.origin === "https://mcp.whop.com" && /^\/mcp\/?$/.test(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}
