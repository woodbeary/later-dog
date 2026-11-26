import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import diskProgram from "./disk.program.txt";
import coordinatorProgram from "./coordinator.program.txt";

const hash = /^[a-f0-9]{64}$/;
const scope = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const origin = "http://restore.r2";
const notFound = () => new Response(null, { status: 404 });
const hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
const prefix = env => {
  if (!hash.test(env.TENANT)) throw Error("Invalid candidate tenant");
  return "homes/" + env.TENANT + "/";
};

async function permit(env, requestId) {
  if (!hash.test(requestId)) throw Error("Invalid candidate run");
  const body = await (await env.STATE.get(prefix(env) + "work-folders/cutover-runs/" + requestId))?.arrayBuffer();
  if (!body || await hex(body) !== requestId) throw Error("Missing immutable candidate run");
  const p = JSON.parse(new TextDecoder().decode(body));
  if (p.v !== 1 || p.stable !== env.TENANT || p.image !== env.IMAGE_HASH || ![p.index, p.verification, p.baselineManifest, p.placement, p.image].every(x => typeof x === "string" && hash.test(x))) throw Error("Invalid restore authorization");
  return p;
}

export class CandidateReader extends WorkerEntrypoint {
  async fetch(request) {
    const u = new URL(request.url);
    if (request.method !== "GET" || u.origin !== origin || u.search) return notFound();
    const { run, id } = this.ctx.props;
    if (id !== this.env.DISKS.idFromName(this.env.TENANT).toString()) return notFound();
    const p = run, root = prefix(this.env);
    let path;
    const fields = u.pathname.slice(1).split("/");
    if (fields.length === 1 && fields[0] === "permit") return Response.json(p);
    if (fields.length === 1 && fields[0] === "baseline") path = "work-folders/legacy-manifests/" + p.baselineManifest;
    if (fields.length === 1 && fields[0] === "proof") path = "work-folders/verification/" + p.verification;
    if (fields.length === 1 && fields[0] === "placement") path = "work-folders/placements/" + p.placement;
    if (fields.length === 2 && hash.test(fields[1])) {
      if (fields[0] === "plans") path = "work-folders/cutover-plans/" + p.verification + "/" + fields[1];
      if (fields[0] === "legacy") path = "blobs/" + fields[1];
    }
    if (fields.length === 4 && scope.test(fields.slice(1, 3).join("/")) && hash.test(fields[3])) {
      if (fields[0] === "chunks") path = "work-folders/v1/" + fields.slice(1, 3).join("/") + "/blobs/" + fields[3];
      if (fields[0] === "versions") path = "work-folders/v1/" + fields.slice(1, 3).join("/") + "/versions/" + fields[3];
    }
    if (!path) return notFound();
    const object = await this.env.STATE.get(root + path);
    return object ? new Response(object.body, { headers: { "content-length": String(object.size) } }) : notFound();
  }
}

const launch = `
const {spawn} = require("node:child_process"), fs = require("node:fs");
const [program,coord,run,identity] = process.argv.slice(1);
fs.mkdirSync("/run/folder-restore",{recursive:true,mode:448});
fs.writeFileSync("/run/folder-restore/coordinator.mjs",coord,{mode:384});
const fd=fs.openSync("/run/folder-restore/candidate.log","a",384);
const child=spawn("flock",["-n","/run/folder-restore/restore.lock","python3","-c",program,run,identity],{detached:true,stdio:["ignore",fd,fd]});
child.unref();fs.closeSync(fd);
`;

export class RestoreDisk extends DurableObject {
  async start(runId) {
    const disk = this.ctx.container, run = await permit(this.env, runId);
    if (this.ctx.id.toString() !== this.env.DISKS.idFromName(this.env.TENANT).toString()) throw Error("Unexpected candidate disk");
    const previous = await this.ctx.storage.get("run");
    if (disk.running && previous && previous !== runId) {
      const state = await this.status();
      if (state.run !== previous || !["verified", "failed"].includes(state.state)) throw Error("Earlier candidate still using the disk");
    }
    await disk.interceptOutboundHttp("restore.r2", this.ctx.exports.CandidateReader({ props: { run, id: this.ctx.id.toString() } }));
    if (!disk.running) disk.start({ image: disk.images.base, enableInternet: false, entrypoint: ["/bin/sh", "-c", "exec /bin/sleep infinity"] });
    await disk.setInactivityTimeout(60 * 60_000);
    if (disk.images.base && !disk.images.base.includes(this.env.IMAGE_HASH) && !(await disk.inspect())?.image?.includes(this.env.IMAGE_HASH)) throw Error("Unexpected candidate image");
    const proc = await disk.exec(["node", "-e", launch, diskProgram, coordinatorProgram, runId, this.ctx.id.toString()], { user: "root", stderr: "ignore" });
    if ((await proc.output()).exitCode !== 0) throw Error("Could not start the restore check");
    await this.ctx.storage.put("run", runId);
    return { id: this.ctx.id.toString(), run: runId, image: (await disk.inspect())?.image };
  }
  async status() {
    const disk = this.ctx.container;
    if (!disk.running) return { state: "stopped" };
    const child = await disk.exec(["cat", "/run/folder-restore/status.json"], { stderr: "ignore" });
    const result = await child.output();
    return result.exitCode === 0 ? JSON.parse(new TextDecoder().decode(result.stdout)) : { state: "starting" };
  }
  async stop(run) {
    if (run !== await this.ctx.storage.get("run")) throw Error("Candidate run changed");
    await this.ctx.container.destroy();
    return { state: "stopped" };
  }
}

export class RestoreOperator extends WorkerEntrypoint {
  disk() { return this.env.DISKS.get(this.env.DISKS.idFromName(this.env.TENANT)); }
  start(id) { return this.disk().start(id); }
  status() { return this.disk().status(); }
  stop(id) { return this.disk().stop(id); }
}

export default { fetch: notFound };
