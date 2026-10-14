import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const GOOD_CODE = "12345678";
const base64url = size => randomBytes(size).toString("base64url");

export async function startFakeAccounts({ homeOrigin = "https://home.fixture.test", now = () => Date.now(), requireTrustedOrigin = false } = {}) {
  const f = {
    requests: [], sent: [], signedOut: [], homeState: "ready", setup: undefined, otp: GOOD_CODE, failSend: null, failVerify: null,
    tokens: new Map(), sessions: new Map(), authorizations: new Map(), pairings: 0, accountId: "fixture-account",
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    f.requests.push({ method: req.method, route: req.url, authorization: req.headers.authorization, origin: req.headers.origin, body });
    const send = (status, data, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(data)); };
    if (requireTrustedOrigin && req.url.startsWith("/api/auth/") && req.headers.origin !== f.origin) return send(403, { error: "forbidden" });
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (req.url === "/api/auth/email-otp/send-verification-otp") {
      if (f.failSend) return send(f.failSend.status, f.failSend.body);
      f.sent.push(body.email);
      return send(200, { success: true });
    }
    if (req.url === "/api/auth/sign-in/email-otp") {
      if (f.failVerify) return send(f.failVerify.status, f.failVerify.body);
      if (body.otp !== f.otp) return send(400, { code: "INVALID_OTP", message: "Invalid OTP" });
      const session = `session.${base64url(24)}`;
      f.sessions.set(session, body.email);
      return send(200, { user: { id: f.accountId, email: body.email } }, { "set-auth-token": session });
    }
    if (req.url === "/api/auth/sign-out") {
      if (bearer && f.sessions.delete(bearer)) f.signedOut.push(bearer);
      return send(200, { success: true });
    }
    if (req.url === "/api/cloud/desktop/authorize") {
      const deviceCode = base64url(32);
      const userCode = `ABCDE-${"FGHJKLMNPQRSTUVWXYZ".slice(f.authorizations.size, f.authorizations.size + 5).padEnd(5, "K")}`;
      f.authorizations.set(deviceCode, { userCode, status: "pending", deviceName: body.deviceName });
      return send(200, { cloudContractVersion: 1, deviceCode, userCode, verificationUriComplete: `${f.origin}/cloud/desktop?code=${userCode}`, expiresIn: 600, interval: 5 });
    }
    if (req.url === "/api/cloud/desktop/approve") {
      const email = bearer && f.sessions.get(bearer);
      if (!email) return send(401, { error: "unauthorized" });
      const entry = [...f.authorizations.values()].find(candidate => candidate.userCode === body.userCode);
      if (!entry) return send(404, { error: "not_found" });
      entry.status = "approved"; entry.email = email;
      return send(200, { approved: true });
    }
    if (req.url === "/api/cloud/desktop/token") {
      const entry = f.authorizations.get(body.deviceCode);
      if (!entry || entry.status !== "approved") return send(400, { error: "authorization_pending" });
      entry.status = "redeemed";
      const accessToken = `omc_${base64url(32)}`;
      f.tokens.set(accessToken, entry.email);
      return send(200, { cloudContractVersion: 1, accessToken, expiresAt: now() + 90 * 86_400_000, device: { id: "fixture-device" }, account: { id: f.accountId, email: entry.email } });
    }
    if (req.url === "/api/cloud/desktop/session") {
      const email = bearer && f.tokens.get(bearer);
      if (!email) return send(401, { error: "invalid_token" });
      if (req.method === "DELETE") { f.tokens.delete(bearer); return send(200, { revoked: true }); }
      const machine = f.homeState === "ready" ? { state: "ready", origin: homeOrigin, pairingAvailable: true }
        : { state: f.homeState, origin: homeOrigin, ...(f.setup ? { setup: f.setup } : {}) };
      return send(200, { cloudContractVersion: 1, expiresAt: now() + 90 * 86_400_000, device: { id: "fixture-device" }, account: { id: f.accountId, email },
        entitlement: { plan: "pro", tier: "beta", status: "active", expiresAt: now() + 30 * 86_400_000, version: 1 }, cloud: machine });
    }
    if (req.url === "/api/cloud/desktop/pairing") {
      if (!(bearer && f.tokens.get(bearer))) return send(401, { error: "invalid_token" });
      f.pairings++;
      return send(200, { cloudContractVersion: 1, origin: homeOrigin, code: "ABCD-EFGH-JKLM", expiresAt: now() + 5 * 60_000 });
    }
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  f.goodCode = GOOD_CODE;
  f.close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return f;
}
