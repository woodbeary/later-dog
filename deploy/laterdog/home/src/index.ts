import { ContainerProxy } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { CloudHomeHost, type HomeSummary, type PairOutcome } from "./host.ts";
import { homeIdentity, machineFromHost } from "./identity.ts";

export { CloudHomeHost, ContainerProxy };

const CLIENT_IP_HEADER = "x-laterdog-client-ip";
const PAIRING_LABEL = /^[^\p{Cc}]{1,80}$/u;

async function homeFor(env: Env, accountId: string) {
  const identity = await homeIdentity(env.HOME_SECRET, accountId, env.HOME_HOST_SUFFIX);
  return { identity, stub: env.HOMES.get(env.HOMES.idFromName(identity.machineId)) };
}

export class HomesApi extends WorkerEntrypoint<Env> {
  async open(accountId: string): Promise<HomeSummary> {
    const { identity, stub } = await homeFor(this.env, accountId);
    await stub.adopt(identity);
    const summary = await stub.summary();
    if (!summary) throw new Error("The home could not be opened.");
    return summary;
  }

  async summary(accountId: string): Promise<HomeSummary | null> {
    const { stub } = await homeFor(this.env, accountId);
    return stub.summary();
  }

  async pair(accountId: string, input: { label: string; ttlSeconds: number }): Promise<PairOutcome> {
    if (!PAIRING_LABEL.test(input.label) || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 30 || input.ttlSeconds > 600) {
      throw new Error("Invalid pairing request.");
    }
    const { stub } = await homeFor(this.env, accountId);
    return stub.pair(input);
  }

  async remove(accountId: string): Promise<{ removed: number }> {
    const { stub } = await homeFor(this.env, accountId);
    return stub.remove();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const machineId = machineFromHost(url.hostname, env.HOME_HOST_SUFFIX);
    if (!machineId) return new Response("Not found", { status: 404 });
    const headers = new Headers(request.headers);
    headers.set(CLIENT_IP_HEADER, request.headers.get("cf-connecting-ip") ?? "");
    const stub = env.HOMES.get(env.HOMES.idFromName(machineId));
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
