#!/usr/bin/env node
// Switch on later.dog Cloud payments, once. Asks for a Square access token
// without showing it, finds (or creates) the "later.dog Cloud" $10/month
// subscription plan in that Square account, and stores the three values the
// worker reads (src/square.ts) as Cloudflare secrets. Nothing is written to
// disk and the token never appears in a command line.
//
//   node scripts/square-setup.mjs            # production
//   node scripts/square-setup.mjs --sandbox  # Square sandbox
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const sandbox = process.argv.includes("--sandbox");
const API = sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
const VERSION = "2026-05-20";
const PLAN_NAME = "later.dog Cloud";
const PRICE_CENTS = 1000;

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) { reject(new Error("Run this in a terminal: it asks for the token without showing it.")); return; }
    process.stdout.write(question);
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          input.setRawMode(false); input.pause(); input.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") { input.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on("data", onData);
  });
}

async function square(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "square-version": VERSION, "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Square ${method} ${path} failed: ${JSON.stringify(json.errors ?? response.status).slice(0, 400)}`);
  return json;
}

function putSecret(name, value) {
  const result = spawnSync("pnpm", ["exec", "wrangler", "secret", "put", name], { input: value, stdio: ["pipe", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`wrangler could not store ${name}`);
}

const token = await askHidden(`Square ${sandbox ? "sandbox" : "production"} access token: `);
if (!token) throw new Error("No token entered.");

const { locations = [] } = await square(token, "GET", "/v2/locations");
const location = locations.find((entry) => entry.status === "ACTIVE") ?? locations[0];
if (!location) throw new Error("This Square account has no location.");
console.log(`Location: ${location.name} (${location.id})`);

// The plan's monthly variation: reuse one named later.dog Cloud, else create it.
const found = await square(token, "POST", "/v2/catalog/search", { object_types: ["SUBSCRIPTION_PLAN"], include_related_objects: true });
const plan = (found.objects ?? []).find((object) => object.subscription_plan_data?.name === PLAN_NAME);
let variationId = plan?.subscription_plan_data?.subscription_plan_variations?.[0]?.id
  ?? (found.related_objects ?? []).find((object) => object.type === "SUBSCRIPTION_PLAN_VARIATION" && object.subscription_plan_variation_data?.subscription_plan_id === plan?.id)?.id;
if (!variationId) {
  const planId = plan?.id ?? (await square(token, "POST", "/v2/catalog/object", {
    idempotency_key: randomUUID(),
    object: { type: "SUBSCRIPTION_PLAN", id: "#later-dog-cloud", subscription_plan_data: { name: PLAN_NAME } },
  })).catalog_object.id;
  const created = await square(token, "POST", "/v2/catalog/object", {
    idempotency_key: randomUUID(),
    object: {
      type: "SUBSCRIPTION_PLAN_VARIATION",
      id: "#monthly",
      subscription_plan_variation_data: {
        name: "Monthly",
        subscription_plan_id: planId,
        phases: [{ cadence: "MONTHLY", ordinal: 0, pricing: { type: "STATIC", price_money: { amount: PRICE_CENTS, currency: "USD" } } }],
      },
    },
  });
  variationId = created.catalog_object.id;
  console.log(`Created the ${PLAN_NAME} plan, $${PRICE_CENTS / 100}/month.`);
} else {
  console.log(`Using the existing ${PLAN_NAME} plan.`);
}

putSecret("SQUARE_ACCESS_TOKEN", token);
putSecret("SQUARE_LOCATION_ID", location.id);
putSecret("SQUARE_PLAN_VARIATION_ID", variationId);
if (sandbox) putSecret("SQUARE_ENVIRONMENT", "sandbox");

const offer = await fetch("https://cloud.later.dog/v1/trials").then((response) => response.json()).catch(() => ({}));
console.log(offer.planOffered ? "Done: later.dog Cloud is on sale." : "Secrets stored. If the plan doesn't show as offered within a minute, run: pnpm run deploy:worker");
