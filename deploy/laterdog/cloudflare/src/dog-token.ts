// A dog's bearer for the supervisor API, derived exactly as server/laterdog/dog-access.ts derives it:
// base64url(HMAC-SHA256(key = the admin token, message = "laterdog-dog:<botId>")), sent with X-LaterDog-Bot: <botId>.
// The Worker recomputes it from LATERDOG_TOKEN, so nothing new is stored. No imports, so server/laterdog/dog-access.test.ts
// can check this copy against the supervisor's under Node.

export const DOG_HEADER = "x-laterdog-bot";
/** The bot IDs the supervisor accepts in that header. */
export const DOG_BOT_ID = /^[\w-]{1,100}$/;

export async function dogToken(adminToken: string, botId: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(adminToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`laterdog-dog:${botId}`)));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
