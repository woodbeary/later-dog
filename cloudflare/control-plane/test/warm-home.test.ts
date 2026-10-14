import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { homeAllowed } from "../src/cloud";
import { emailFromCodeRequest, warmHomeForEmail } from "../src/warm-home";

async function person(email: string): Promise<string> {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .bind(id, email.split("@")[0], email, at, at).run();
  return id;
}

function opener() {
  const opened: string[] = [];
  return { opened, async open(accountId: string) { opened.push(accountId); return { state: "setting_up" as const }; } };
}

describe("warming a home when its owner asks for a sign-in code", () => {
  it("wakes the home of someone who already has one", async () => {
    const ada = await person("Ada@Example.com");
    expect(await homeAllowed(env as unknown as Env, ada)).toBe(true);
    const homes = opener();
    expect(await warmHomeForEmail(env as unknown as Env, homes as never, "ada@example.com")).toBe(true);
    expect(homes.opened).toEqual([ada]);
  });

  it("never starts a home for an address with no account or no home yet", async () => {
    await person("grace@example.com");
    const homes = opener();
    expect(await warmHomeForEmail(env as unknown as Env, homes as never, "grace@example.com")).toBe(false);
    expect(await warmHomeForEmail(env as unknown as Env, homes as never, "nobody@example.com")).toBe(false);
    expect(homes.opened).toEqual([]);
  });

  it("reads the address from the code request and ignores anything else", async () => {
    const request = (body: unknown) => new Request("https://accounts.later.dog/api/auth/email-otp/send-verification-otp", { method: "POST", body: JSON.stringify(body) });
    expect(await emailFromCodeRequest(request({ email: " Ada@Example.com ", type: "sign-in" }))).toBe("ada@example.com");
    expect(await emailFromCodeRequest(request({ email: 42 }))).toBeNull();
    expect(await emailFromCodeRequest(request({}))).toBeNull();
  });
});
