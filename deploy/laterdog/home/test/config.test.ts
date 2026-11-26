import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = new URL("../", import.meta.url);
const OWNER = "7eaec07f-4e74-4682-81c2-d3bf10549606";

const productionCapacityHomes = [OWNER, "test-capacity-placement-261126"].join(",");

function config(name: string) {
  return JSON.parse(readFileSync(new URL(name, here), "utf8"));
}

describe.each(["wrangler.jsonc", "wrangler.production.json", "wrangler.bootstrap.json"])("%s", (name) => {
  const worker = config(name);
  const container = (className: string) => worker.containers.find((entry: { class_name: string }) => entry.class_name === className);

  it("gives standard homes standard-1 and large homes standard-4", () => {
    expect(container("CloudHomeHost")).toMatchObject({ instance_type: "standard-1", max_instances: 400 });
    expect(container("CloudHomeHostLarge")).toMatchObject({ instance_type: "standard-4", max_instances: 10 });
    expect(container("CloudHomeHostLarge").image_build_context).toBe(container("CloudHomeHost").image_build_context);
    expect(worker.containers).toHaveLength(2);
  });

  it("binds both classes as SQLite Durable Objects", () => {
    expect(worker.durable_objects.bindings).toEqual([
      { name: "HOMES", class_name: "CloudHomeHost" },
      { name: "HOMES_LARGE", class_name: "CloudHomeHostLarge" },
    ]);
    expect(worker.exports).toEqual({
      CloudHomeHost: { type: "durable-object", storage: "sqlite" },
      CloudHomeHostLarge: { type: "durable-object", storage: "sqlite" },
    });
    expect(worker.migrations).toBeUndefined();
  });

  it("preserves the production owner and capacity test home placements", () => {
    expect(worker.vars.LARGE_HOME_ACCOUNTS).toBe(name === "wrangler.production.json" ? productionCapacityHomes : "");
  });

  it("keeps a tenth of the Worker's logs", () => {
    expect(worker.observability).toEqual({ enabled: true, head_sampling_rate: 0.1 });
  });
});

describe.each(["wrangler.jsonc", "wrangler.production.json", "wrangler.bootstrap.json", "wrangler.test.json"])("%s wake guard", (name) => {
  it("boots for any well-formed owner credential until the deploy says owners", () => {
    expect(config(name).vars.HOME_WAKE_GUARD).toBe("learning");
  });
});

describe.each(["wrangler.jsonc", "wrangler.bootstrap.json"])("%s images", (name) => {
  it("builds both home classes from the same source", () => {
    const [standard, large] = config(name).containers;
    expect(large.image).toBe(standard.image);
  });
});

describe("home image promotion", () => {
  const production = config("wrangler.production.json");
  const staging = config("wrangler.test.json");

  it.each(["CloudHomeHost", "CloudHomeHostLarge"])("promotes the tested immutable %s image", (className) => {
    const imageFor = (worker: typeof production) => worker.containers.find((entry: { class_name: string }) => entry.class_name === className).image;
    expect(imageFor(production)).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(imageFor(production)).toBe(imageFor(staging));
  });

  it("enables Codex archival only for the owner and the staging writer", () => {
    expect(production.vars.CODEX_ARCHIVE_ACCOUNTS).toBe(OWNER);
    expect(staging.vars.CODEX_ARCHIVE_ACCOUNTS).toBe("test-cold-codex-writer");
    expect(staging.vars.LARGE_HOME_ACCOUNTS).toBe("test-cold-codex-writer,test-capacity-bundle-nov26");
    expect(config("wrangler.jsonc").vars.CODEX_ARCHIVE_ACCOUNTS).toBe("");
    expect(config("wrangler.bootstrap.json").vars.CODEX_ARCHIVE_ACCOUNTS).toBe("");
  });
});

describe.each(["wrangler.jsonc", "wrangler.bootstrap.json"])("%s dev code", (name) => {
  it("never runs server code pushed for testing", () => {
    expect(config(name).vars.DEV_CODE).toBe("");
  });
});

describe("wrangler.production.json dev code", () => {
  it("runs server code pushed from later.dog Dev on the enrolled production homes", () => {
    expect(config("wrangler.production.json").vars.DEV_CODE).toBe(productionCapacityHomes);
  });
});

describe("wrangler.test.json dev code", () => {
  it("runs server code pushed for testing", () => {
    expect(config("wrangler.test.json").vars.DEV_CODE).toBe("1");
  });
});
