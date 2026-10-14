import { describe, expect, it, vi } from "vitest";
import { EMAIL_MAX_BYTES, handleOwnerEmail, type OwnerMail } from "../src/email.ts";

const PARAMS = { token: "home-email-token", accountId: "user-1" };
const email = { subject: "Your file", text: "Here it is.", attachments: [{ filename: "scan.pdf", type: "application/pdf", content: "JVBERi0=" }] };

function post(body: unknown, token = PARAMS.token): Request {
  return new Request("http://email.internal/send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

function mail(answer: Awaited<ReturnType<OwnerMail["sendOwnerEmail"]>> = { ok: true }) {
  return { sendOwnerEmail: vi.fn(async () => answer) };
}

describe("a home emailing its owner", () => {
  it("passes a well-formed email to the accounts service for this home's account", async () => {
    const accounts = mail();
    const response = await handleOwnerEmail(post(email), PARAMS, accounts);
    expect(response.status).toBe(200);
    expect(accounts.sendOwnerEmail).toHaveBeenCalledWith("user-1", email);
  });

  it("refuses anything without this home's token", async () => {
    const accounts = mail();
    expect((await handleOwnerEmail(post(email, "guess"), PARAMS, accounts)).status).toBe(401);
    expect((await handleOwnerEmail(post(email), { token: PARAMS.token }, accounts)).status).toBe(401);
    expect(accounts.sendOwnerEmail).not.toHaveBeenCalled();
  });

  it("refuses odd emails and oversized ones before sending", async () => {
    const accounts = mail();
    expect((await handleOwnerEmail(post({ ...email, to: "x@y.z" }), PARAMS, accounts)).status).toBe(200);
    expect((await handleOwnerEmail(post({ ...email, attachments: [{ filename: "../a", type: "text/plain", content: "" }] }), PARAMS, accounts)).status).toBe(400);
    expect((await handleOwnerEmail(post({ ...email, subject: "" }), PARAMS, accounts)).status).toBe(400);
    const huge = { ...email, attachments: [{ filename: "big.bin", type: "application/octet-stream", content: "A".repeat(EMAIL_MAX_BYTES + 4) }] };
    expect((await handleOwnerEmail(post(huge), PARAMS, accounts)).status).toBe(413);
    expect(accounts.sendOwnerEmail).toHaveBeenCalledTimes(1);
  });

  it("passes on the accounts service's refusal", async () => {
    const response = await handleOwnerEmail(post(email), PARAMS, mail({ ok: false, status: 429, error: "You've had today's emails from your dogs. They come back tomorrow." }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "You've had today's emails from your dogs. They come back tomorrow." });
  });
});
