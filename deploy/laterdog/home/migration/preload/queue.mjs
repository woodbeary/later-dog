import { WorkerEntrypoint } from "cloudflare:workers";
import policy from "./catalog.generated.json";

const allowed = new Set(policy.batches);
const prefixFor = env => (policy.fixture && env.COPY_QUEUE_SHARDS ? "private-multiqueue-qualification/" : "private-immutable-readbacks/") + policy.catalog + "/";
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), n => n.toString(16).padStart(2,"0")).join("");

async function matches(job) {
  return job && job.catalog === policy.catalog && allowed.has(job.id) && Array.isArray(job.objects) && job.id === await digest([job.scope,job.objects]);
}

export class PrivateCopyQueue extends WorkerEntrypoint {
  async inventory() {
    const courier = await this.env.COPY.inventory();
    if (courier.catalog !== policy.catalog || courier.stable !== policy.stable || courier.service !== policy.service) throw new Error("The private courier differs");
    return { catalog:policy.catalog, service:policy.service, objects:policy.objects, batches:allowed.size };
  }

  async enqueue(jobs) {
    if (!Array.isArray(jobs) || !jobs.length || jobs.length > 24 || !(await Promise.all(jobs.map(matches))).every(Boolean)) throw new Error("Invalid immutable batch submission");
    const shards = Number(this.env.COPY_QUEUE_SHARDS || "1");
    const batches = new Map();
    for (const job of jobs) {
      const number = parseInt(job.id.slice(0, 8), 16) % shards;
      if (!batches.has(number)) batches.set(number, []);
      batches.get(number).push({ body: job });
    }
    await Promise.all([...batches].map(([number, messages]) => {
      const queue = shards === 1 ? this.env.JOBS : this.env["JOBS_" + number];
      return queue.sendBatch(messages);
    }));
    return { accepted: jobs.map(job=>job.id) };
  }

  async list(cursor) {
    const page = await this.env.RECEIPTS.list({ prefix:prefixFor(this.env), limit:1000, cursor:cursor||undefined, include:["customMetadata"] });
    return { rows:page.objects.map(object=>[object.key.slice(prefixFor(this.env).length), object.customMetadata]), cursor:page.truncated?page.cursor:null };
  }
}

async function processMessage(env, message) {
  const job = message.body;
  if (!await matches(job)) { message.ack(); return; }
  const key = prefixFor(env) + job.id;
  if (await env.RECEIPTS.head(key)) { message.ack();return; }
  try {
    const copied = await env.COPY.process("copy", job.scope, job.objects);
    const result = await env.COPY.process("verify", job.scope, job.objects);
    if (copied.batch !== job.id || copied.count !== job.objects.length || copied.action !== "copy" || result.batch !== job.id || result.count !== job.objects.length || result.action !== "verify") throw new Error("Unexpected immutable readback");
    const evidence = {count:String(result.count), bytes:String(result.bytes), copied:String(copied.bytes), verified:"true"};
    await env.RECEIPTS.put(key,JSON.stringify({catalog:policy.catalog,job:job.id,...evidence}),{onlyIf:{etagDoesNotMatch:"*"},customMetadata:evidence});
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({batch:job.id,attempt:message.attempts,error:error instanceof Error ? error.message.slice(0,150) : "Receipt unavailable"}));
    message.retry({delaySeconds:Math.min(45,2*message.attempts)});
  }
}

export default {
  fetch() { return new Response(null,{status:404}); },
  async queue(batch,env) { await Promise.all(batch.messages.map(message=>processMessage(env,message))); },
};
