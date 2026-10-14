import { WorkerEntrypoint } from "cloudflare:workers";

const homes = new Map();
const hex = (value) => [...value].map((character) => character.charCodeAt(0).toString(16)).join("");
const originFor = (accountId) => `https://h${hex(accountId).slice(0, 24).padEnd(24, "0")}-home.later.dog`;

export class HomesApi extends WorkerEntrypoint {
  async open(accountId) {
    if (!homes.has(accountId)) homes.set(accountId, { state: "ready", origin: originFor(accountId) });
    return { ...homes.get(accountId) };
  }
  async summary(accountId) {
    const home = homes.get(accountId);
    return home ? { ...home } : null;
  }
  async pair(accountId, input) {
    const home = homes.get(accountId);
    if (!home) return { ok: false, summary: null };
    return { ok: true, origin: home.origin, code: "ABCD-EFGH-JKLM", credential: "laterdog_pair_0123456789abcdefghij", expiresAt: Date.now() + input.ttlSeconds * 1000 };
  }
  async remove(accountId) {
    homes.delete(accountId);
    return { removed: 1 };
  }
}

export default {
  fetch() {
    return new Response("the test home service");
  },
};
