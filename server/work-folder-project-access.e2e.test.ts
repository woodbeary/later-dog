import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorkFolder, type WorkFolderBucket } from "../deploy/laterdog/home/src/work-folder-store.ts";
import { projectAccessAuthority, projectAccessPath } from "../shared/work-folder-project-access.ts";
import { ProjectAccessController } from "./laterdog/project-access.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

it("saves the owner's new dog and shared room selections, retains other grants and rejects home internals", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dog-project-access-"))),
    data = join(root, ".laterdog"),
    project = join(root, "Shared");
  const fixtureHost = "laterdog-t-0123456789ab.fly.dev",
    origin = "https://" + fixtureHost,
    secret = randomBytes(32).toString("base64url"),
    stable = "0".repeat(64);
  const file = join(root, "placement.json"),
    socket = join(root, "permissions.sock");
  const placement = {
    v: 1,
    mode: "folders",
    previous: null,
    verification: "1".repeat(64),
    baselineManifest: "2".repeat(64),
    layout: { dogs: [], tasks: {}, projects: [{ path: project, owner: "steward", members: [] }] },
  };
  const objects = new Map<string, { etag: string; bytes: Buffer }>();
  const bucket: WorkFolderBucket = {
    async get(k) {
      const row = objects.get(k);
      return row ? { ...row, size: row.bytes.length, body: new Response(new Uint8Array(row.bytes)).body! } : null;
    },
    async head(k) {
      return objects.has(k) ? { size: objects.get(k)!.bytes.length } : null;
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
    async put(k, v, options) {
      const old = objects.get(k),
        condition = options.onlyIf;
      if ("etagMatches" in condition ? old?.etag !== condition.etagMatches : !!old) return null;
      const bytes =
        typeof v === "string"
          ? Buffer.from(v)
          : v instanceof ReadableStream
            ? Buffer.from(await new Response(v).arrayBuffer())
            : Buffer.from(new Uint8Array(v));
      objects.set(k, { etag: crypto.randomUUID(), bytes });
      return {};
    },
  };
  mkdirSync(data);
  mkdirSync(project);
  writeFileSync(file, JSON.stringify(placement));
  await bucket.put("homes/" + stable + "/work-folders/placement", JSON.stringify(placement), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const edge = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const b of req) parts.push(b);
    const response = await handleWorkFolder(
      new Request(origin + req.url, {
        method: req.method,
        headers: { authorization: req.headers.authorization ?? "" },
        ...(parts.length ? { body: Buffer.concat(parts) } : {}),
      }),
      bucket,
      stable,
      origin,
      secret,
    );
    res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
  });
  let openWriter = false;
  const checkpoint = createServer((req, res) =>
    res.writeHead(req.url === "/v1/reload" ? (openWriter ? 409 : 204) : 404).end(),
  );
  let app: ChildProcess | undefined;
  try {
    edge.listen(0, "127.0.0.1");
    await once(edge, "listening");
    checkpoint.listen(socket);
    await once(checkpoint, "listening");
    const endpoint = "http://127.0.0.1:" + (edge.address() as { port: number }).port;
    const port = await freePortBlock([0, 1]),
      appUrl = "http://127.0.0.1:" + port;
    const prelude =
      "const real=globalThis.fetch;globalThis.fetch=(url,opt)=>String(url).startsWith(" +
      JSON.stringify(origin + "/api/work-folders/v1/") +
      ")?real(" +
      JSON.stringify(endpoint) +
      "+new URL(url).pathname+new URL(url).search,opt):Promise.resolve(new Response(null,{status:503}));";
    const start = async () => {
      app = spawn(
        process.execPath,
        ["--import", "data:text/javascript," + encodeURIComponent(prelude), join(import.meta.dirname, "index.ts")],
        {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            LATERDOG_HOME: data,
            LATERDOG_SERVER_PORT: String(port),
            LATERDOG_WEBHOOK_PORT: String(port + 1),
            LATERDOG_CLOUD_ROLE: "home",
            LATERDOG_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93",
            LATERDOG_CLOUD_ADMIN_URL: "https://cloud.example.test",
            LATERDOG_PUBLIC_URL: origin,
            LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret,
            LATERDOG_WORK_FOLDER_LAYOUT: file,
            LATERDOG_WORK_FOLDER_CHECKPOINT_SOCKET: socket,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let log = "";
      app.stderr?.on("data", (b) => {
        log += b;
      });
      app.stdout?.on("data", (b) => {
        log += b;
      });
      await expect
        .poll(
          async () => {
            if (app?.exitCode !== null) throw Error(log);
            try {
              return (await fetch(appUrl + "/api/health")).ok;
            } catch {
              return false;
            }
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    };
    await start();
    let token = "";
    const api = async (method: string, path: string, value?: unknown, extra: Record<string, string> = {}) => {
      const res = await fetch(appUrl + path, {
        method,
        headers: {
          host: fixtureHost,
          "x-forwarded-for": "203.0.113.9",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
          ...extra,
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
      return {
        status: res.status,
        data: (await res.json()) as {
          code: string;
          token: string;
          bot: { id: string };
          bots: { id: string }[];
          group: { id: string };
        },
      };
    };
    const body = { label: "shared-project fixture", ttlSeconds: 300 },
      ts = String(Math.floor(Date.now() / 1000)),
      nonce = randomBytes(16).toString("base64url");
    const pair = await api("POST", "/api/cloud/pairing", body, {
      "x-laterdog-cloud-timestamp": ts,
      "x-laterdog-cloud-nonce": nonce,
      "x-laterdog-cloud-signature": "v1=" + cloudPairingSignature(secret, ts, nonce, JSON.stringify(body)),
    });
    token = (await api("POST", "/api/auth/pair", { code: pair.data.code })).data.token;
    expect(token).toBeTruthy();
    const one = await api("POST", "/api/bots", {
      name: "First",
      settings: { cwd: project },
      hello: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    });
    expect(one.status, JSON.stringify(one.data)).toBe(201);
    const two = await api("POST", "/api/bots", {
      name: "Second",
      hello: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    });
    expect(two.status, JSON.stringify(two.data)).toBe(201);
    const ids = [one.data.bot.id, two.data.bot.id];
    const untrusted = new ProjectAccessController(structuredClone(placement.layout), data, endpoint, secret, () => {});
    await expect(
      untrusted.change(
        false,
        [{ subject: "dog:self", cwd: project, members: ["self"] }],
        () => [],
        async (_loss, commit) => commit(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const group = await api("POST", "/api/groups", { name: "Sharing", memberIds: ids });
    expect(group.status, JSON.stringify(group.data)).toBe(201);
    const groupPath = "/api/groups/" + group.data.group.id;
    const selected = await api("PATCH", groupPath, { cwd: project });
    expect(selected.status, JSON.stringify(selected.data)).toBe(200);
    const state = async () => {
      const r = await handleWorkFolder(
        new Request(origin + projectAccessPath, {
          headers: { authorization: "Bearer " + (await projectAccessAuthority(secret)) },
        }),
        bucket,
        stable,
        origin,
        secret,
      );
      return ((await r.json()) as { access: { bindings: { subject: string; members: string[] }[] } }).access.bindings;
    };
    expect(await state()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: "dog:" + ids[0], members: [ids[0]] }),
        expect.objectContaining({ subject: "room:" + group.data.group.id, members: [...ids].sort() }),
      ]),
    );
    expect((await api("PATCH", "/api/bots/" + ids[0], { cwd: data })).status).toBe(400);
    await waitForExit(app, { signal: "SIGTERM" });
    await start();
    expect((await api("PATCH", groupPath, { cwd: null })).status).toBe(200);
    expect(await state()).toEqual([expect.objectContaining({ subject: "dog:" + ids[0] })]);
    expect((await api("PATCH", "/api/bots/" + ids[0], { cwd: null })).status).toBe(200);
    expect(await state()).toEqual([]);
    const team = {
      format: "laterdog.team",
      version: 2,
      team: { name: "Project import", members: [{ key: "new", name: "Imported dog", appearance: { color: "pink" } }] },
    };
    const target = "/api/teams/import?mode=project&cwd=" + encodeURIComponent(project);
    const count = async () => (await api("GET", "/api/bots")).data.bots.length;
    const before = await count();
    openWriter = true;
    expect((await api("POST", target, team)).status).toBe(409);
    expect(await count()).toBe(before);
    expect(await state()).toEqual([]);
    openWriter = false;
    const imported = await api("POST", target, team);
    expect(imported.status, JSON.stringify(imported.data)).toBe(201);
    expect(await state()).toEqual([
      expect.objectContaining({ subject: "room:" + imported.data.group.id, members: [imported.data.bots[0].id] }),
    ]);
    const packaged = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"),
    );
    const secondImport = await api("POST", target, packaged);
    expect(secondImport.status, JSON.stringify(secondImport.data)).toBe(201);
    expect(await state()).toContainEqual(
      expect.objectContaining({
        subject: "room:" + secondImport.data.group.id,
        members: secondImport.data.bots.map((bot) => bot.id).sort(),
      }),
    );
  } finally {
    if (app) await waitForExit(app, { signal: "SIGTERM" });
    await Promise.all([edge, checkpoint].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    await removeTempDir(root);
  }
}, 90_000);
