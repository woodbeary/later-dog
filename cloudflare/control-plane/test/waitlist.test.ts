import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { homeAllowed } from "../src/cloud";
import { INVITE_HOLD_MS, INVITE_SUBJECT, inviteFromWaitlist, type InviteSender } from "../src/waitlist";

const NOW = 1_800_000_000_000;

async function person(email: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .bind(id, email.split("@")[0], email, new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();
  return id;
}

function capped(cap: number): Env {
  return { ...env, CLOUD_HOME_CAP: String(cap) } as unknown as Env;
}

function outbox(): InviteSender & { sent: string[] } {
  const sent: string[] = [];
  return { sent, async send(message) { expect(message.subject).toBe(INVITE_SUBJECT); sent.push(message.to); } };
}

describe("the later.dog Cloud waitlist", () => {
  it("puts people turned away by the cap on the list, and invites them in order when there's room", async () => {
    const ada = await person("ada@example.com"), grace = await person("grace@example.com"), lin = await person("lin@example.com");
    expect(await homeAllowed(capped(1), ada, NOW)).toBe(true);
    expect(await homeAllowed(capped(1), grace, NOW + 1)).toBe(false);
    expect(await homeAllowed(capped(1), lin, NOW + 2)).toBe(false);
    const mail = outbox();
    expect(await inviteFromWaitlist(capped(1), 1, mail, NOW + 3)).toBe(0);
    expect(await inviteFromWaitlist(capped(2), 2, mail, NOW + 4)).toBe(1);
    expect(mail.sent).toEqual(["grace@example.com"]);
    expect(await inviteFromWaitlist(capped(2), 2, mail, NOW + 5)).toBe(0);
  });

  it("holds an invited person's spot for two days, so a newcomer can't take it", async () => {
    const ada = await person("ada@example.com"), grace = await person("grace@example.com"), newcomer = await person("new@example.com");
    expect(await homeAllowed(capped(1), ada, NOW)).toBe(true);
    expect(await homeAllowed(capped(1), grace, NOW + 1)).toBe(false);
    await inviteFromWaitlist(capped(2), 2, outbox(), NOW + 2);
    expect(await homeAllowed(capped(2), newcomer, NOW + 3)).toBe(false);
    expect(await homeAllowed(capped(2), grace, NOW + 4)).toBe(true);
  });

  it("lets the spot go after two days if the invite isn't used", async () => {
    const ada = await person("ada@example.com"), grace = await person("grace@example.com"), newcomer = await person("new@example.com");
    await homeAllowed(capped(1), ada, NOW);
    await homeAllowed(capped(1), grace, NOW + 1);
    await inviteFromWaitlist(capped(2), 2, outbox(), NOW + 2);
    expect(await homeAllowed(capped(2), newcomer, NOW + 2 + INVITE_HOLD_MS + 1)).toBe(true);
  });

  it("stops inviting when email can't go out, without marking anyone invited", async () => {
    const ada = await person("ada@example.com"), grace = await person("grace@example.com");
    await homeAllowed(capped(1), ada, NOW);
    await homeAllowed(capped(1), grace, NOW + 1);
    const failing: InviteSender = { async send() { throw Object.assign(new Error("E_DAILY_LIMIT_EXCEEDED"), { code: "E_DAILY_LIMIT_EXCEEDED" }); } };
    expect(await inviteFromWaitlist(capped(2), 2, failing, NOW + 2)).toBe(0);
    expect(await inviteFromWaitlist(capped(2), 2, outbox(), NOW + 3)).toBe(0);
    const mail = outbox();
    expect(await inviteFromWaitlist(capped(2), 2, mail, NOW + 2 + 60 * 60_000 + 1)).toBe(1);
    expect(mail.sent).toEqual(["grace@example.com"]);
  });
});
