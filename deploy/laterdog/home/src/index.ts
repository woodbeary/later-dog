import { ContainerProxy } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { CloudHomeHost, CloudHomeHostLarge, CloudHomeHostCandidate, type HomeSummary, type PairOutcome } from "./host.ts";
import { homeIdentity, machineFromHost } from "./identity.ts";
import { candidateHomes, homeLane, homeLanes, homeNamespace, largeHomes, type HomeLane } from "./size.ts";

export { CloudHomeHost, CloudHomeHostLarge, CloudHomeHostCandidate, ContainerProxy };

const CLIENT_IP_HEADER = "x-laterdog-client-ip";
const PAIRING_LABEL = /^[^\p{Cc}]{1,80}$/u;

function hostFor(env: Env, lane: HomeLane, machineId: string) {
  const namespace = homeNamespace(env, lane);
  return namespace.get(namespace.idFromName(machineId));
}

async function homeFor(env: Env, accountId: string) {
  const identity = await homeIdentity(env.HOME_SECRET, accountId, env.HOME_HOST_SUFFIX);
  const lane = await homeLane(env, identity.machineId);
  return { identity, lane, stub: hostFor(env, lane, identity.machineId) };
}

async function adoptedHomeFor(env: Env, accountId: string) {
  const home = await homeFor(env, accountId);
  if (home.lane === "candidate") await hostFor(env, "standard", home.identity.machineId).adopt(home.identity);
  if (home.lane !== "standard") await home.stub.adopt(home.identity);
  return home;
}

async function hostForMachine(env: Env, machineId: string) {
  const lane = await homeLane(env, machineId);
  const owner = (await candidateHomes(env)).get(machineId) ?? (await largeHomes(env)).get(machineId);
  if (!owner) return hostFor(env, "standard", machineId);
  const stub = hostFor(env, lane, machineId);
  if (lane === "candidate") await hostFor(env, "standard", machineId).adopt(owner);
  await stub.adopt(owner);
  return stub;
}

export class HomesApi extends WorkerEntrypoint<Env> {
  async open(accountId: string): Promise<HomeSummary> {
    const { identity, lane, stub } = await homeFor(this.env, accountId);
    if (lane !== "standard") {
      const standard = hostFor(this.env, "standard", identity.machineId);
      await standard.reopen();
      if (lane === "candidate") await standard.adopt(identity);
    }
    await stub.reopen();
    await stub.adopt(identity);
    const summary = await stub.summary();
    if (!summary) throw new Error("The home could not be opened.");
    return summary;
  }

  async summary(accountId: string): Promise<HomeSummary | null> {
    const { stub } = await adoptedHomeFor(this.env, accountId);
    return stub.summary();
  }

  async pair(accountId: string, input: { label: string; ttlSeconds: number }): Promise<PairOutcome> {
    if (!PAIRING_LABEL.test(input.label) || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 30 || input.ttlSeconds > 600) {
      throw new Error("Invalid pairing request.");
    }
    const { stub } = await adoptedHomeFor(this.env, accountId);
    return stub.pair(input);
  }

  async remove(accountId: string): Promise<{ removed: number }> {
    const { identity } = await homeFor(this.env, accountId);
    const standard = hostFor(this.env, "standard", identity.machineId);
    const owners = homeLanes(this.env).map((lane) => ({ lane, owner: hostFor(this.env, lane, identity.machineId) }));
    await Promise.all(owners.map(({ owner }) => owner.bury()));
    await Promise.all(owners.filter(({ lane }) => lane !== "standard").map(({ owner }) => owner.forget()));
    return standard.remove();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const machineId = machineFromHost(url.hostname, env.HOME_HOST_SUFFIX);
    if (!machineId) return new Response("Not found", { status: 404 });
    const headers = new Headers(request.headers);
    headers.set(CLIENT_IP_HEADER, request.headers.get("cf-connecting-ip") ?? "");
    const stub = await hostForMachine(env, machineId);
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
