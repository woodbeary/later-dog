import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_JOB_ASK_EVERY_MS, CLOUD_JOB_UNCONFIRMED_MS, CLOUD_JOB_WATCH_MS, createCloudJobWatch, supervisorJobStates, type CloudJobStates,
} from "./cloud-job-watch.ts";

const JOB = "0b9f6c1e-3c1d-4a8e-9a57-6f0f5f2a1c11";
const OTHER = "7d4b2a90-1e2f-4c3d-8b5a-9c8d7e6f5a40";
const HOUR = 60 * 60_000;

let dir = "";
let now = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "laterdog-cloud-jobs-"));
  now = 1_800_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function watchWith(states: CloudJobStates) {
  return createCloudJobWatch({ file: join(dir, "cloud-jobs-waited-for.json"), states, now: () => now, log: () => {} });
}

function answering(state: Record<string, string> | null) {
  const asked: string[][] = [];
  const states: CloudJobStates = async (ids) => {
    asked.push(ids);
    return state ? new Map(Object.entries(state)) : null;
  };
  return { asked, states };
}

describe("waiting for the cloud jobs a home's dogs started", () => {
  it("counts a job as in flight until the supervisor says it is done", async () => {
    let state = "running";
    const watch = watchWith(async () => new Map([[JOB, state]]));
    expect(watch.inFlight()).toBe(false);
    watch.watch(JOB);
    expect(watch.inFlight()).toBe(true);
    await watch.refresh();
    expect(watch.inFlight()).toBe(true);
    state = "ready";
    await watch.refresh();
    expect(watch.inFlight()).toBe(false);
  });

  it("doesn't wait for a job that needs the person or one the supervisor doesn't know", async () => {
    const unknown = watchWith(async () => new Map([[JOB, "submission_unknown"]]));
    unknown.watch(JOB);
    await unknown.refresh();
    expect(unknown.inFlight()).toBe(false);
    rmSync(join(dir, "cloud-jobs-waited-for.json"));
    const forgotten = watchWith(async () => new Map());
    forgotten.watch(JOB);
    await forgotten.refresh();
    expect(forgotten.inFlight()).toBe(false);
  });

  it("keeps waiting while the supervisor can't be asked, but not three hours without word", async () => {
    const watch = watchWith(answering(null).states);
    watch.watch(JOB);
    now += CLOUD_JOB_UNCONFIRMED_MS - 1;
    await watch.refresh();
    expect(watch.inFlight()).toBe(true);
    now += 1;
    expect(watch.inFlight()).toBe(false);
  });

  it("stops waiting twelve hours after the job started, even if the supervisor still calls it running", async () => {
    const watch = watchWith(answering({ [JOB]: "running" }).states);
    watch.watch(JOB);
    for (let hour = 1; hour < 12; hour += 1) {
      now += HOUR;
      await watch.refresh();
      expect(watch.inFlight()).toBe(true);
    }
    now += HOUR;
    expect(now).toBe(1_800_000_000_000 + CLOUD_JOB_WATCH_MS);
    expect(watch.inFlight()).toBe(false);
  });

  it("asks at most once a minute, by itself, and keeps a job watched while it was asking", async () => {
    const { asked, states } = answering({ [JOB]: "running" });
    const watch = watchWith(states);
    watch.watch(JOB);
    expect(watch.inFlight()).toBe(true);
    watch.watch(OTHER);
    await watch.refresh();
    expect(asked).toEqual([[JOB]]);
    now += CLOUD_JOB_ASK_EVERY_MS - 1;
    expect(watch.inFlight()).toBe(true);
    expect(asked).toHaveLength(1);
    now += 1;
    expect(watch.inFlight()).toBe(true);
    await watch.refresh();
    expect(asked[1]).toEqual([JOB, OTHER]);
    expect(JSON.parse(readFileSync(join(dir, "cloud-jobs-waited-for.json"), "utf8")).jobs.map((job: { id: string }) => job.id)).toEqual([JOB]);
  });

  it("remembers what it waits for across a restart, and starts empty from a damaged file", () => {
    watchWith(answering(null).states).watch(JOB);
    expect(watchWith(answering(null).states).inFlight()).toBe(true);
    writeFileSync(join(dir, "cloud-jobs-waited-for.json"), "{not json");
    expect(watchWith(answering(null).states).inFlight()).toBe(false);
  });

  it("ignores anything that isn't a job id", () => {
    const watch = watchWith(answering(null).states);
    watch.watch("../../etc");
    watch.watch(`${JOB},${OTHER}`);
    expect(watch.inFlight()).toBe(false);
  });
});

describe("asking the supervisor about jobs", () => {
  it("asks for just those jobs with the desktop's token, and reads their states", async () => {
    vi.stubEnv("LATERDOG_SUPERVISOR_URL", "https://supervisor.example");
    vi.stubEnv("LATERDOG_TOKEN", "desktop-token");
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ jobs: [{ id: JOB, state: "running" }, { id: OTHER, state: "ready" }, { id: 4 }] });
    }) as typeof fetch;
    expect(await supervisorJobStates(fetcher)([JOB, OTHER])).toEqual(new Map([[JOB, "running"], [OTHER, "ready"]]));
    expect(seen).toEqual([{ url: `https://supervisor.example/v1/jobs?ids=${JOB},${OTHER}`, auth: "Bearer desktop-token" }]);
  });

  it("answers nothing when the supervisor refuses, fails or can't be reached", async () => {
    vi.stubEnv("LATERDOG_SUPERVISOR_URL", "https://supervisor.example");
    vi.stubEnv("LATERDOG_TOKEN", "desktop-token");
    expect(await supervisorJobStates((async () => new Response("no", { status: 401 })) as typeof fetch)([JOB])).toBeNull();
    expect(await supervisorJobStates((async () => Response.json({ nope: true })) as typeof fetch)([JOB])).toBeNull();
    expect(await supervisorJobStates((async () => { throw new Error("offline"); }) as typeof fetch)([JOB])).toBeNull();
  });
});
