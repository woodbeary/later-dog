import { randomUUID } from "node:crypto";
import { managedCompanionTunnelAccess, withManagedCompanionTunnelAccess, withoutManagedCompanionTunnelAccess } from "./managed-companion-tunnel.mjs";

const FIELD = "accountWorkspace";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL = /^laterdog_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const PAIRING = /^laterdog_pair_[A-Za-z0-9_-]{43}$/;
const POLL_MS = 5_000;
const ERRORS = new Set(["endpoints_unavailable", "workspace_unlinked", "workspace_bound_elsewhere", "endpoint_capacity", "endpoint_rate_limited", "unauthorized", "invalid_token", "network_unavailable", "endpoint_unavailable", "installation_limit_reached", "credential_rotation_rate_limited"]);

export function createAccountWorkspace({ account, controlPlane, readCredentials, updateCredentials, identity,
  startCompanion, stopEndpoint, companionState, connectionState, openPairing, closePairing, revokeAccountDevices,
  onStatus = () => {}, now = Date.now, newId = randomUUID, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let closed = false, timer = null, running = null, again = false, generation = 0, activeKey = null;
  let pending = null, provisioned = false, endpointVerified = false, endpointRetryAt = 0, lastStatus = "";
  const report = status => { if (status !== lastStatus) { lastStatus = status; onStatus(status); } };
  const state = () => account()?.state();
  const key = () => {
    const value = state();
    return value?.account?.id && value.deviceId && !["signed-out", "reauth-required"].includes(value.status)
      ? `${value.account.id}:${value.deviceId}` : null;
  };
  const current = stamp => !closed && generation === stamp && activeKey !== null && activeKey === key();
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = delay => {
    cancelTimer();
    if (!closed && activeKey) {
      timer = setTimer(() => { timer = null; void refresh(); }, delay);
      timer?.unref?.();
    }
  };
  async function abandonPairing() {
    const previous = pending;
    pending = null;
    if (previous) await closePairing(previous.credential).catch(() => {});
  }
  async function credentials(stamp) {
    const value = state(), saved = readCredentials()?.[FIELD];
    const same = saved?.accountId === value.account.id && saved?.deviceId === value.deviceId;
    if (same && UUID.test(saved.installationId) && CREDENTIAL.test(saved.credential) && saved.expiresAt > now() + 60_000) return saved;
    const clientInstanceId = UUID.test(saved?.clientInstanceId) ? saved.clientInstanceId : newId();
    await updateCredentials(document => current(stamp) ? { ...document, [FIELD]: { ...document[FIELD], clientInstanceId } } : document);
    if (!current(stamp)) return null;
    const enrolled = await account().workspaceInstallation({ clientInstanceId, ...identity });
    if (!current(stamp)) return null;
    if (!UUID.test(enrolled?.installation?.id) || !CREDENTIAL.test(enrolled?.credential) ||
      !Number.isSafeInteger(enrolled.credentialExpiresAt) || enrolled.credentialExpiresAt <= now()) throw new Error("Invalid workspace installation");
    const next = { clientInstanceId, accountId: value.account.id, deviceId: value.deviceId,
      installationId: enrolled.installation.id, credential: enrolled.credential, expiresAt: enrolled.credentialExpiresAt };
    if ((!same || saved.installationId !== next.installationId) && managedCompanionTunnelAccess(readCredentials())) {
      await stopEndpoint();
    }
    await updateCredentials(document => current(stamp)
      ? { ...(!same || saved.installationId !== next.installationId ? withoutManagedCompanionTunnelAccess(document) : document), [FIELD]: next }
      : document);
    provisioned = false;
    endpointVerified = false;
    return current(stamp) ? next : null;
  }
  async function work() {
    const wanted = key();
    const stored = readCredentials()?.[FIELD];
    const signedOut = !wanted && ["signed-out", "reauth-required"].includes(state()?.status) && state()?.message !== "restoring";
    if (wanted !== activeKey || stored?.revokePending || (signedOut && stored?.accountId && !stored.revoked)) {
      generation++;
      const previous = activeKey;
      activeKey = wanted;
      provisioned = false;
      endpointVerified = false;
      endpointRetryAt = 0;
      await abandonPairing();
      const saved = readCredentials()?.[FIELD];
      if (previous || saved?.revokePending || signedOut || (saved?.accountId && (saved.accountId !== state()?.account?.id || saved.deviceId !== state()?.deviceId))) {
        await stopEndpoint();
        await updateCredentials(document => ({ ...withoutManagedCompanionTunnelAccess(document), [FIELD]: { ...document[FIELD], revokePending: true } }));
        await revokeAccountDevices();
        await updateCredentials(document => ({ ...document, [FIELD]: { ...document[FIELD], revokePending: false, revoked: true } }));
      }
    }
    const stamp = generation;
    if (!current(stamp)) { report("signed-out"); return; }
    const saved = await credentials(stamp);
    if (!saved || !current(stamp)) return;
    const client = account();
    if (!provisioned) {
      const result = await client.workspaceHeartbeat({ installationId: saved.installationId, ready: false });
      if (!current(stamp) || !result?.bound) return;
      if (now() < endpointRetryAt) return;
      try {
        if (!endpointVerified) {
          const endpoint = await controlPlane.ensureEndpoint(saved.credential);
          if (!current(stamp)) return;
          await updateCredentials(document => current(stamp) ? withManagedCompanionTunnelAccess(document, endpoint) : document);
          if (current(stamp)) endpointVerified = true;
        }
        if (!current(stamp)) return;
        await startCompanion();
        if (!current(stamp)) return;
        provisioned = true;
      } catch (error) {
        endpointRetryAt = now() + Math.max(60_000, error?.retryAfterMs ?? 0);
        if (error?.status === 401) {
          await updateCredentials(document => ({ ...document, [FIELD]: { ...document[FIELD], expiresAt: 0 } }));
        }
        throw error;
      }
    }
    const local = await companionState();
    if (!current(stamp)) return;
    const access = managedCompanionTunnelAccess(readCredentials()), connection = connectionState();
    const ready = local?.enabled === true && !local.error && connection?.ready === true &&
      access !== null && connection.url === access.endpoint;
    if (!local?.enabled || local.error) provisioned = false;
    if (pending && local.accountPairingActive === false) pending = null;
    if (pending && (pending.expiresAt <= now() || !ready)) await abandonPairing();
    const response = await client.workspaceHeartbeat({ installationId: saved.installationId, ready,
      ...(pending && ready ? { pairing: pending } : {}) });
    if (!current(stamp)) return;
    if (!response?.bound) { await abandonPairing(); await stopEndpoint(); provisioned = false; return; }
    report(ready ? "ready" : "offline");
    const request = response.request;
    if (!ready || !request || !UUID.test(request.id) || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= now()) return;
    if (pending?.requestId === request.id) return;
    if (pending) return;
    const opened = await openPairing();
    if (!opened?.opened || !PAIRING.test(opened.credential) || !Number.isSafeInteger(opened.expiresAt)) return;
    if (!current(stamp)) { await closePairing(opened.credential).catch(() => {}); return; }
    pending = { requestId: request.id, credential: opened.credential, expiresAt: Math.min(opened.expiresAt, request.expiresAt, now() + 120_000) };
    await client.workspaceHeartbeat({ installationId: saved.installationId, ready: true, pairing: pending });
  }
  function refresh() {
    if (closed) return Promise.resolve();
    if (running) { again = true; return running; }
    cancelTimer();
    running = (async () => {
      do {
        again = false;
        try { await work(); } catch (error) {
          report(ERRORS.has(error?.code) ? error.code : "workspace_unavailable");
          if (error?.code === "invalid_token" && error?.status === 401) await account()?.refresh().catch(() => {});
          if (error?.code === "workspace_unlinked") {
            provisioned = false;
            endpointVerified = false;
            await updateCredentials(document => ({ ...document, [FIELD]: { ...document[FIELD], expiresAt: 0 } })).catch(() => {});
          }
        }
      } while (again && !closed);
    })().finally(() => { running = null; schedule(POLL_MS); });
    return running;
  }
  return {
    refresh,
    changed() {
      if (key() !== activeKey) generation++;
      return refresh();
    },
    close() { closed = true; generation++; cancelTimer(); void abandonPairing(); },
  };
}
