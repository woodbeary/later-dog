import { describe, expect, it } from "vitest";
import { allowedItems, appName, grantItem, withoutGrant } from "./allowed";

describe("what a dog may do without asking", () => {
  it("names each standing permission the way the person granted it", () => {
    expect(grantItem("connector:googlecalendar")).toEqual({ kind: "connector", key: "connector:googlecalendar", app: "Google Calendar" });
    expect(grantItem("connector:zoho_crm")).toMatchObject({ kind: "connector", app: "Zoho Crm" });
    expect(grantItem("ask_bot:dog-2")).toEqual({ kind: "askDog", key: "ask_bot:dog-2", dogId: "dog-2" });
    expect(grantItem("delegate_bot:dog-3")).toEqual({ kind: "delegateDog", key: "delegate_bot:dog-3", dogId: "dog-3" });
    expect(grantItem("vault:google.com")).toEqual({ kind: "vault", key: "vault:google.com", site: "google.com" });
    expect(grantItem("vault:localhost")).toEqual({ kind: "other", key: "vault:localhost" });
    expect(grantItem("Bash")).toEqual({ kind: "other", key: "Bash" });
    expect(appName("github")).toBe("GitHub");
  });

  it("lists app and dog permissions first, then exact commands", () => {
    const rule = { id: "r1", command: "pnpm test", cwd: "/work/app", providerInstanceId: "codex" };
    expect(allowedItems(["connector:gmail"], [rule]).map((item) => item.kind)).toEqual(["connector", "command"]);
    expect(allowedItems(undefined, [])).toEqual([]);
  });

  it("removes one permission and keeps the rest", () => {
    expect(withoutGrant(["connector:gmail", "ask_bot:d2"], "connector:gmail")).toEqual(["ask_bot:d2"]);
    expect(withoutGrant(undefined, "x")).toEqual([]);
  });
});
