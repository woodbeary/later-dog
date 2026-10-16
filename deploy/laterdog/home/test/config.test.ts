import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = new URL("../", import.meta.url);

function config(name: string) {
  return JSON.parse(readFileSync(new URL(name, here), "utf8"));
}

describe.each(["wrangler.jsonc", "wrangler.production.json", "wrangler.bootstrap.json"])("%s", (name) => {
  const worker = config(name);
  const container = (className: string) => worker.containers.find((entry: { class_name: string }) => entry.class_name === className);

  it("keeps every home on standard-1 and gives the large class standard-4 from the same image", () => {
    expect(container("CloudHomeHost")).toMatchObject({ instance_type: "standard-1", max_instances: 400 });
    expect(container("CloudHomeHostLarge")).toMatchObject({ instance_type: "standard-4", max_instances: 10 });
    expect(container("CloudHomeHostLarge").image).toBe(container("CloudHomeHost").image);
    expect(container("CloudHomeHostLarge").image_build_context).toBe(container("CloudHomeHost").image_build_context);
    expect(container("CloudHomeHostCandidate")).toMatchObject({ instance_type: "standard-1", max_instances: 2 });
    expect(worker.containers).toHaveLength(3);
  });

  it("binds both classes as SQLite Durable Objects", () => {
    expect(worker.durable_objects.bindings).toEqual([
      { name: "HOMES", class_name: "CloudHomeHost" },
      { name: "HOMES_LARGE", class_name: "CloudHomeHostLarge" },
      { name: "HOMES_CANDIDATE", class_name: "CloudHomeHostCandidate" },
    ]);
    expect(worker.exports).toEqual({
      CloudHomeHost: { type: "durable-object", storage: "sqlite" },
      CloudHomeHostLarge: { type: "durable-object", storage: "sqlite" },
      CloudHomeHostCandidate: { type: "durable-object", storage: "sqlite" },
    });
    expect(worker.migrations).toBeUndefined();
  });

  it("lists nobody for a large home unless the deploy says so", () => {
    expect(worker.vars.LARGE_HOME_ACCOUNTS).toBe("");
    expect(worker.vars.CANDIDATE_HOME_ACCOUNTS).toBe("");
    expect(worker.vars.CANDIDATE_HOME_CHECKPOINTS).toBe("{}");
    expect(worker.vars.CANDIDATE_HOME_IMAGE_DIGEST).toBe("");
  });
});
