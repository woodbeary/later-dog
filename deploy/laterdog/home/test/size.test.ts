import { describe, expect, it } from "vitest";
import { homeIdentity } from "../src/identity.ts";
import { homeNamespace, homeSize, largeHomeAccounts, largeHomes, otherSize } from "../src/size.ts";

const env = (accounts?: string) => ({ HOME_SECRET: "size-secret", HOME_HOST_SUFFIX: "-home.later.dog", LARGE_HOME_ACCOUNTS: accounts });

describe("who gets a large home", () => {
  it("reads a comma-separated list of account ids and ignores blanks, repeats and anything that is not an id", () => {
    expect(largeHomeAccounts(undefined)).toEqual([]);
    expect(largeHomeAccounts("")).toEqual([]);
    expect(largeHomeAccounts(" owner-1 ,, owner-2,owner-1, not an id ,")).toEqual(["owner-1", "owner-2"]);
  });

  it("gives a large home only to the machines of listed owners", async () => {
    const owner = await homeIdentity("size-secret", "owner-1", "-home.later.dog");
    const someone = await homeIdentity("size-secret", "someone", "-home.later.dog");
    expect(await homeSize(env("owner-1"), owner.machineId)).toBe("large");
    expect(await homeSize(env("owner-1"), someone.machineId)).toBe("standard");
    expect(await homeSize(env(""), owner.machineId)).toBe("standard");
    expect(await homeSize(env(), owner.machineId)).toBe("standard");
    expect((await largeHomes(env("owner-1"))).get(owner.machineId)).toEqual(owner);
  });

  it("follows the list when it changes", async () => {
    const owner = await homeIdentity("size-secret", "owner-1", "-home.later.dog");
    expect(await homeSize(env("owner-1"), owner.machineId)).toBe("large");
    expect(await homeSize(env("owner-2"), owner.machineId)).toBe("standard");
    expect(await homeSize(env("owner-2,owner-1"), owner.machineId)).toBe("large");
  });

  it("picks the namespace for each size", () => {
    const namespaces = { HOMES: "standard homes", HOMES_LARGE: "large homes" };
    expect(homeNamespace(namespaces, "standard")).toBe("standard homes");
    expect(homeNamespace(namespaces, "large")).toBe("large homes");
    expect(otherSize("standard")).toBe("large");
    expect(otherSize("large")).toBe("standard");
  });
});
