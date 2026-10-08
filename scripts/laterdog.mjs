import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimes = join(homedir(),".nvm","versions","node");
const installed = existsSync(runtimes) ? readdirSync(runtimes).filter((v) => Number(v.match(/^v(\d+)/)?.[1]) >= 24).sort((a,b) => b.localeCompare(a,undefined,{ numeric: true })) : [];
const binary = Number(process.versions.node.split(".")[0]) >= 24 ? process.execPath : installed.length ? join(runtimes,installed[0],"bin","node") : undefined;
if (!binary) { console.error("later.dog needs Node 24 or newer. Install Node 24, then run pnpm laterdog:dev."); process.exit(1); }
const command = process.argv[2] ?? "dev";
const children = new Set(); let stopping = false;
const env = { ...process.env, PATH: `${dirname(binary)}${delimiter}${process.env.PATH ?? ""}` };
const dataRoot = env.LATERDOG_HOME ?? join(homedir(),".laterdog");
// Mirrors supervisorConnection() in server/laterdog/config.ts: the environment wins, then the saved <data>/supervisor.json, else the local supervisor.
function connection() {
  if (env.LATERDOG_SUPERVISOR_URL) return { url: env.LATERDOG_SUPERVISOR_URL, tokenFile: env.LATERDOG_TOKEN_FILE, source: "environment" };
  const file = join(dataRoot,"supervisor.json");
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file,"utf8"));
    return { url: saved.url, tokenFile: typeof saved.tokenFile === "string" ? saved.tokenFile.replace(/^~(?=\/)/,homedir()) : undefined, source: file };
  }
  return { url: "http://127.0.0.1:9010", source: "local" };
}
function start(args, extraEnv = {}) {
  const child = spawn(binary,args,{ cwd: root, env: { ...env,...extraEnv }, stdio: "inherit" }); children.add(child);
  child.on("error",(error) => { console.error(error.message); stop(1); });
  child.on("exit",(code) => { children.delete(child); if (!stopping) stop(code ?? 1); }); return child;
}
function stop(code = 0) { if (stopping) return; stopping = true; process.exitCode = code; for (const child of children) child.kill("SIGTERM"); }
process.on("SIGINT",() => stop()); process.on("SIGTERM",() => stop());
if (command === "dev") {
  const port = env.LATERDOG_SERVER_PORT ?? "9011"; const uiPort = env.LATERDOG_UI_PORT ?? "5299";
  const shared = { LATERDOG_SERVER_PORT: port, LATERDOG_UI_PORT: uiPort, LATERDOG_WORKSPACE_URL: `http://127.0.0.1:${port}` };
  const supervisor = connection();
  // A hosted supervisor replaces the local one: starting both would hold port 9010 for nothing and fail when another desktop already has it.
  if (supervisor.source === "local") start(["server/laterdog/main.ts"],shared);
  start(["server/index.ts"],shared); start(["node_modules/vite/bin/vite.js"],shared);
  console.log(`later.dog: http://127.0.0.1:${uiPort}. Supervisor: ${supervisor.url}${supervisor.source === "local" ? " (local, started here)" : ` (hosted, from ${supervisor.source})`}. Agents keep their data in ${dataRoot}.`);
} else if (["supervisor","mcp","bridge"].includes(command)) {
  start([`server/laterdog/${command === "supervisor" ? "main" : command}.ts`,...process.argv.slice(3)]);
} else if (command === "doctor" || command === "login") {
  const supervisor = connection();
  const dataDir = env.LATERDOG_DATA_DIR ?? join(dataRoot,"supervisor");
  const tokenFile = supervisor.tokenFile ?? join(dataDir,"access-token");
  const token = (env.LATERDOG_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile,"utf8") : "")).trim();
  const origin = supervisor.url; const profile = env.LATERDOG_PROFILE ?? "default";
  const call = (path, init = {}) => fetch(`${origin}${path}`,{ ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, redirect: "error", signal: AbortSignal.timeout(init.timeoutMs ?? 5000) });
  if (!token) { console.error(supervisor.source === "local" ? "Start the supervisor first; no credential file exists yet." : `No supervisor token at ${tokenFile}; check ${supervisor.source}.`); process.exitCode = 1; }
  else if (command === "doctor") {
    try {
      const response = await call("/v1/workspace",{ timeoutMs: 60_000 });
      if (!response.ok) throw new Error(`Supervisor returned ${response.status}`); const snapshot = await response.json();
      const describe = (path, timeoutMs) => call(path,{ timeoutMs }).then((r) => r.ok ? r.json() : { error: `${path} returned ${r.status}` }).catch((error) => ({ error: error.message }));
      // Profile access runs the provider CLI inside the supervisor; the GitHub check runs gh there. Neither prints a credential.
      const [access, github] = await Promise.all([describe(`/v1/profiles/${profile}/access`,90_000), describe("/v1/github/access",40_000)]);
      console.log(JSON.stringify({ connected: true, origin, source: supervisor.source, repositories: snapshot.repositories.length, jobs: snapshot.jobs.length, active: snapshot.active, concurrency: snapshot.concurrency,
        publishingHost: snapshot.publishingHost, wakeupsConfigured: snapshot.wakeupsConfigured, backends: snapshot.backends, profile: { id: profile, ...access }, github },null,2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  } else {
    // Starts the provider's device login inside the supervisor's own process space (a remote container has no shell) and prints
    // the verification URL and code. Finish it in a browser, then run `pnpm laterdog:doctor` to confirm `authenticated: true`.
    try {
      const response = await call(`/v1/profiles/${profile}/login`,{ method: "POST", timeoutMs: 30_000 });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Supervisor returned ${response.status}`);
      console.log(body.instructions); console.log(`\n(${body.started ? "login started" : "login already in progress"} at ${body.startedAt}; the supervisor keeps it running until you confirm in the browser)`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
} else if (command === "github") {
  // Connects the supervisor to GitHub with GitHub's own device sign-in, run on the supervisor's host: this prints a code, you
  // enter it at github.com/login/device and authorize, and the login lives (backed up encrypted) where the supervisor runs.
  // No token is copied or pasted anywhere. A fine-grained PAT as the GH_TOKEN secret remains the stricter alternative.
  const supervisor = connection();
  const tokenFile = supervisor.tokenFile ?? join(env.LATERDOG_DATA_DIR ?? join(dataRoot,"supervisor"),"access-token");
  const bearer = (env.LATERDOG_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile,"utf8") : "")).trim();
  if (!bearer) { console.error(`No supervisor token at ${tokenFile}; check ${supervisor.source}.`); process.exit(1); }
  const headers = { authorization: `Bearer ${bearer}` };
  const access = async () => { const r = await fetch(`${supervisor.url}/v1/github/access`,{ headers, signal: AbortSignal.timeout(60_000) }); if (!r.ok) throw new Error(`Supervisor returned ${r.status}`); return r.json(); };
  try {
    const before = await access();
    if (before.authenticated) { console.log(`GitHub is already connected: ${before.login} via ${before.source}.`); process.exit(0); }
    const started = await fetch(`${supervisor.url}/v1/github/login`,{ method: "POST", headers, signal: AbortSignal.timeout(60_000) }).then((r) => r.json());
    if (started.phase !== "waiting" || !started.code) { console.error(started.detail ?? started.error ?? "GitHub sign-in could not start."); process.exit(1); }
    console.log(`Open ${started.url} and enter the code ${started.code}, then click Authorize.\n(The code expires in 15 minutes; waiting for you…)`);
    for (const deadline = Date.now() + 15 * 60_000; Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve,5000));
      const now = await access().catch(() => null);
      if (now?.authenticated) { console.log(`GitHub connected: ${now.login}. Cloud jobs can publish pull requests now.`); process.exit(0); }
      if (now?.signIn?.phase === "failed") { console.error(now.signIn.detail ?? "GitHub sign-in did not finish."); process.exit(1); }
    }
    console.error("The code expired before it was authorized; run pnpm laterdog:github again."); process.exit(1);
  } catch (error) { console.error(error.message); process.exit(1); }
} else { console.error("Use dev, supervisor, mcp, bridge, doctor, login, or github."); process.exitCode = 1; }
