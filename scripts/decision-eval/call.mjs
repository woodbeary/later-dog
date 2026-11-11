import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MODEL_IDS = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
  clairic: "@cf/cloudflare/clairic",
};

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const required = (name) => {
  const value = argument(name);
  if (!value) throw new Error(`Supply ${name}.`);
  return value;
};

const target = required("--target");
const requests = JSON.parse(readFileSync(required("--requests"), "utf8"));
const outPath = required("--out");
const timeoutMs = Number(argument("--timeout-ms") ?? 20_000);
const pauseMs = Number(argument("--pause-ms") ?? 50);
const label = argument("--label") ?? target;
const onlyModels = argument("--models")?.split(",");
const onlyGroups = argument("--groups")?.split(",");
const limit = argument("--limit") ? Number(argument("--limit")) : Infinity;

function bearer() {
  const fromEnv = argument("--token-env");
  if (fromEnv) {
    const value = process.env[fromEnv]?.trim();
    if (!value) throw new Error(`${fromEnv} is empty.`);
    return value;
  }
  const keyFile = argument("--key-file");
  if (keyFile) return readFileSync(keyFile, "utf8").trim();
  const wranglerConfig = argument("--wrangler-config");
  if (wranglerConfig) {
    const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(readFileSync(wranglerConfig, "utf8"))?.[1];
    if (!token) throw new Error("No oauth_token in the Wrangler config.");
    return token;
  }
  throw new Error("Supply --token-env, --key-file or --wrangler-config.");
}

function endpoint(model) {
  if (target === "workers-ai") {
    return `https://api.cloudflare.com/client/v4/accounts/${required("--account-id")}/ai/run/${MODEL_IDS[model]}`;
  }
  if (target === "relay") return `${required("--relay").replace(/\/+$/, "")}/v1/systemone`;
  throw new Error("--target is workers-ai or relay.");
}

const token = bearer();
const done = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : [];
const finished = new Set(done.filter((row) => row.ok).map((row) => row.id));
const wanted = requests
  .filter((call) => (!onlyModels || onlyModels.includes(call.model)) && (!onlyGroups || onlyGroups.includes(call.group)))
  .filter((call) => !finished.has(call.id))
  .slice(0, limit);
const kept = done.filter((row) => row.ok || !wanted.some((call) => call.id === row.id));

async function run(call) {
  const started = performance.now();
  const at = new Date().toISOString();
  const base = { id: call.id, group: call.group, model: call.model, item: call.item, target: label, at };
  try {
    const response = await fetch(endpoint(call.model), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const latencyMs = Math.round(performance.now() - started);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ...base, latencyMs, status: response.status, ok: false, error: "not JSON" };
    }
    if (!response.ok) return { ...base, latencyMs, status: response.status, ok: false, error: JSON.stringify(body.errors ?? body.error ?? body).slice(0, 300) };
    return { ...base, latencyMs, status: response.status, ok: true, result: target === "workers-ai" ? body.result : body };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    return { ...base, latencyMs, ok: false, error: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

let failures = 0;
for (const call of wanted) {
  const row = await run(call);
  kept.push(row);
  if (!row.ok) failures += 1;
  writeFileSync(outPath, JSON.stringify(kept));
  if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
}
console.log(JSON.stringify({ target: label, asked: wanted.length, failed: failures, saved: kept.length }));
