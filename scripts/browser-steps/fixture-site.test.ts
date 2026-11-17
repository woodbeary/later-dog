import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURE_ACCOUNT, FIXTURE_ANSWERS, startFixtureSite } from "./fixture-site.ts";
import { refFor } from "./measure.ts";

let site: Awaited<ReturnType<typeof startFixtureSite>>;
beforeAll(async () => { site = await startFixtureSite(); });
afterAll(async () => { await site.close(); });

const get = (path: string, init?: RequestInit) => fetch(`${site.origin}${path}`, { redirect: "manual", ...init });
const form = (fields: Record<string, string>) => ({ method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("the browser-steps fixture site", () => {
  it("lists the kettle's price and links the shipping policy that holds the threshold", async () => {
    const shop = await (await get("/shop")).text();
    expect(shop).toContain(`<strong>Blue Kettle</strong> · ${FIXTURE_ANSWERS.find.price}`);
    expect(shop).toContain('<a href="/shipping">Shipping policy</a>');
    expect(await (await get("/shipping")).text()).toContain(`free on orders over ${FIXTURE_ANSWERS.find.threshold}`);
  });

  it("gives the reference only when all five fields are sent", async () => {
    const full = { name: "Ada", email: "a@example.test", phone: "1", topic: "billing", message: "hi" };
    expect(await (await get("/contact", form(full))).text()).toContain(FIXTURE_ANSWERS.form.reference);
    expect(await (await get("/contact", form({ ...full, phone: "" }))).text()).not.toContain(FIXTURE_ANSWERS.form.reference);
  });

  it("sends a visitor without a session to sign in, and shows the table after it", async () => {
    const wall = await get("/orders");
    expect([wall.status, wall.headers.get("location")]).toEqual([303, "/login"]);
    expect((await get("/login", form({ username: FIXTURE_ACCOUNT.username, password: "wrong" }))).status).toBe(200);
    const signedIn = await get("/login", form({ ...FIXTURE_ACCOUNT }));
    expect(signedIn.status).toBe(303);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const orders = await (await get("/orders", { headers: { cookie } })).text();
    expect(orders).toContain(`<td>#${FIXTURE_ANSWERS.table.order}</td>`);
    expect(orders).toContain(`<td>${FIXTURE_ANSWERS.table.total}</td><td>${FIXTURE_ANSWERS.table.status}</td>`);
  });
});

describe("refFor", () => {
  it("finds an element's ref by role and name, with or without other attributes", () => {
    const snapshot = '- textbox "Full name" [required, ref=e16]\n- link "Shipping policy" [ref=e21]\n- heading "Contact us" [level=1, ref=e1]';
    expect(refFor(snapshot, "textbox", "Full name")).toBe("@e16");
    expect(refFor(snapshot, "link", "Shipping policy")).toBe("@e21");
    expect(() => refFor(snapshot, "button", "Send")).toThrow(/no button "Send"/);
  });
});
