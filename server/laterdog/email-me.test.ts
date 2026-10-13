import { describe, expect, it, vi } from "vitest";
import { availableTools, catalogProfileFromEnv } from "../drivers/agents-catalog.ts";
import { attachmentType, cloudEmailDelivery, EMAIL_ME_MAX_BYTES, emailMe, type MacRead, type OutgoingEmail } from "./email-me.ts";

const COMPUTER = "8b6b8f3e-5b1a-4a0b-9f35-6f1e2b0c9d11";
const FOLDER = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

const macAnswer = (value: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const macRefusal = (message: string) => ({ isError: true, content: [{ type: "text", text: message }] });

function harness(readMacFile: (operation: MacRead) => Promise<unknown> = async () => macRefusal("no Mac")) {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    deps: {
      botName: "Biscuit",
      readMacFile: vi.fn(readMacFile),
      deliver: async (email: OutgoingEmail) => {
        sent.push(email);
      },
    },
  };
}

describe("email_me", () => {
  it("emails the owner with text and base64 attachments", async () => {
    const { sent, deps } = harness();
    const answer = await emailMe({
      subject: "Your report",
      body: "Here's the summary you asked for.",
      attachments: [
        { filename: "summary.csv", text: "dog,score\nBiscuit,10\n" },
        { filename: "pixel.png", base64: Buffer.from([137, 80, 78, 71]).toString("base64") },
      ],
    }, deps);
    expect(answer).toEqual({ status: 200, body: { sent: true, to: "your later.dog email", attachments: ["summary.csv", "pixel.png"] } });
    expect(sent[0].subject).toBe("Your report");
    expect(sent[0].text).toBe("Here's the summary you asked for.\n\n— Biscuit, your later.dog dog");
    expect(sent[0].attachments.map((attachment) => attachment.type)).toEqual(["text/csv", "image/png"]);
    expect(Buffer.from(sent[0].attachments[0].content, "base64").toString("utf8")).toBe("dog,score\nBiscuit,10\n");
  });

  const ranged = (file: Buffer) => async (operation: MacRead) => {
    const offset = operation.offset ?? 0;
    const part = file.subarray(offset, offset + (operation.length ?? file.length));
    return macAnswer({ content: part.toString("base64"), encoding: "base64", bytes: part.length, offset, size: file.length });
  };

  it("fetches a small file from the lent Mac in one read", async () => {
    const pdf = Buffer.from("%PDF-1.7 tiny");
    const { sent, deps } = harness(ranged(pdf));
    const answer = await emailMe({ subject: "Invoice", body: "Attached.", attachments: [{ computer_id: COMPUTER, folder_id: FOLDER, path: "Invoices/october.pdf" }] }, deps);
    expect(answer.status).toBe(200);
    expect(deps.readMacFile).toHaveBeenCalledOnce();
    expect(deps.readMacFile).toHaveBeenCalledWith({ computer_id: COMPUTER, action: "read_file", folder_id: FOLDER, path: "Invoices/october.pdf", encoding: "base64", offset: 0, length: 262144 });
    expect(sent[0].attachments[0]).toEqual({ filename: "october.pdf", type: "application/pdf", content: pdf.toString("base64") });
  });

  it("fetches a big file from the lent Mac in parts and puts it back together, never asking for more than a part", async () => {
    const big = Buffer.alloc(600_000, 7);
    const reads: MacRead[] = [];
    const read = ranged(big);
    const { sent, deps } = harness(async (operation) => {
      reads.push(operation);
      return read(operation);
    });
    const answer = await emailMe({ subject: "Scan", body: "Here.", attachments: [{ computer_id: COMPUTER, folder_id: FOLDER, path: "Downloads/scan.pdf" }] }, deps);
    expect(answer.status).toBe(200);
    expect(reads.map((entry) => entry.offset)).toEqual([0, 262144, 524288]);
    expect(reads.every((entry) => entry.length === 262144)).toBe(true);
    expect(Buffer.compare(Buffer.from(sent[0].attachments[0].content, "base64"), big)).toBe(0);
  });

  it("refuses a file too big to email after the first part, without sending anything", async () => {
    const { sent, deps } = harness(async (operation) => macAnswer({ content: Buffer.alloc(10).toString("base64"), encoding: "base64", bytes: 10, offset: operation.offset, size: 9_000_000 }));
    const answer = await emailMe({ subject: "Movie", body: "Here.", attachments: [{ computer_id: COMPUTER, folder_id: FOLDER, path: "Downloads/movie.mov" }] }, deps);
    expect(answer.status).toBe(413);
    expect(String(answer.body.error)).toContain("9.0 MB, too big to email");
    expect(sent).toEqual([]);
    expect(deps.readMacFile).toHaveBeenCalledOnce();
  });

  it("emails an empty file", async () => {
    const { sent, deps } = harness(ranged(Buffer.alloc(0)));
    const answer = await emailMe({ subject: "Empty", body: "Here.", attachments: [{ computer_id: COMPUTER, folder_id: FOLDER, path: "empty.txt" }] }, deps);
    expect(answer.status).toBe(200);
    expect(sent[0].attachments[0].content).toBe("");
    expect(deps.readMacFile).toHaveBeenCalledOnce();
  });

  it("passes on the Mac's own refusal", async () => {
    const { sent, deps } = harness(async () => macRefusal("This folder has not been shared with this server"));
    await expect(emailMe({ subject: "x", body: "y", attachments: [{ computer_id: COMPUTER, folder_id: FOLDER, path: "a.txt" }] }, deps)).rejects.toThrow("not been shared");
    expect(sent).toEqual([]);
  });

  it("checks what it was given", async () => {
    const { deps } = harness();
    expect((await emailMe({ subject: "", body: "y" }, deps)).status).toBe(400);
    expect((await emailMe({ subject: "x", body: "y", to: "someone@else.test" }, deps)).status).toBe(400);
    expect((await emailMe({ subject: "x", body: "y", attachments: [{ filename: "../etc/passwd", text: "x" }] }, deps)).status).toBe(400);
    expect((await emailMe({ subject: "x", body: "y", attachments: [{ filename: "a.bin", base64: "!!!not base64" }] }, deps)).status).toBe(400);
    expect((await emailMe({ subject: "x", body: "y", attachments: [{ filename: "huge.txt", text: "a".repeat(EMAIL_ME_MAX_BYTES) }, { filename: "more.txt", text: "b" }] }, deps)).status).toBe(413);
  });

  it("knows common file types", () => {
    expect(attachmentType("Report.PDF")).toBe("application/pdf");
    expect(attachmentType("deck.key")).toBe("application/vnd.apple.keynote");
    expect(attachmentType("mystery.xyz")).toBe("application/octet-stream");
  });

  it("delivers through the home's email channel with its token and explains refusals", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "You've sent today's emails. They come back tomorrow." }, { status: 429 }));
    const deliver = cloudEmailDelivery("http://email.internal/send", "token-1", fetcher as unknown as typeof fetch);
    expect(deliver).not.toBeNull();
    await expect(deliver!({ subject: "s", text: "t", attachments: [] })).rejects.toMatchObject({ status: 429, message: "You've sent today's emails. They come back tomorrow." });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://email.internal/send");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
    expect(cloudEmailDelivery(undefined, "t")).toBeNull();
  });

  it("is offered to dogs only on a home that can send email", () => {
    const names = (env: NodeJS.ProcessEnv) => availableTools(catalogProfileFromEnv(env)).map((tool) => tool.name);
    expect(names({ LATERDOG_CLOUD_HOME: "1" })).not.toContain("email_me");
    expect(names({ LATERDOG_CLOUD_HOME: "1", LATERDOG_EMAIL_ME: "1" })).toContain("email_me");
  });
});
