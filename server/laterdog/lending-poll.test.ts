import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedComputers } from "../shared-computers.ts";
import { requestGone } from "./request-gone.ts";

const secret = "c".repeat(64);
const owner = { session: "owner", person: "cloud-home" };
const mac = () => ({ id: randomUUID(), name: "Jo's MacBook Air", environmentId: randomUUID(), folders: [], terminal: true, computer: false });
const command = (computerId: string) => ({ computer_id: computerId, action: "run_command" as const, command: "ls" });

afterEach(() => vi.useRealTimers());

describe("the Mac's poll for work", () => {
  it("hands a job out again when the poll that carried it never reached the Mac", async () => {
    const broker = new SharedComputers(() => true);
    const computer = mac(); broker.register(computer, owner, secret);
    const result = broker.request(command(computer.id), owner.person, () => true);
    const lost = await broker.poll(computer.id, owner.session, secret);
    expect(lost?.operation.command).toBe("ls");
    const again = await broker.poll(computer.id, owner.session, secret);
    expect(again?.id).toBe(lost!.id);
    expect(broker.liveJob(computer.id, owner.session, secret, again!.id)).toBe(true);
    broker.complete(computer.id, owner.session, secret, again!.id, { content: [{ type: "text", text: "done" }] });
    await expect(result).resolves.toEqual({ content: [{ type: "text", text: "done" }] });
    broker.close();
  });

  it("never hands out twice a job the Mac has started", async () => {
    vi.useFakeTimers();
    const broker = new SharedComputers(() => true);
    const computer = mac(); broker.register(computer, owner, secret);
    const result = broker.request(command(computer.id), owner.person, () => true);
    const job = await broker.poll(computer.id, owner.session, secret);
    expect(broker.liveJob(computer.id, owner.session, secret, job!.id)).toBe(true);
    const next = broker.poll(computer.id, owner.session, secret);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(next).resolves.toBeNull();
    broker.complete(computer.id, owner.session, secret, job!.id, { ok: true });
    await expect(result).resolves.toEqual({ ok: true });
    broker.close();
  });

  it("lets a poll whose request is gone end at once without taking the job, so the next poll gets it", async () => {
    vi.useFakeTimers();
    const broker = new SharedComputers(() => true);
    const computer = mac(); broker.register(computer, owner, secret);
    const left = new AbortController();
    const dropped = broker.poll(computer.id, owner.session, secret, left.signal);
    left.abort();
    await expect(dropped).resolves.toBeNull();
    const result = broker.request(command(computer.id), owner.person, () => true);
    const job = await broker.poll(computer.id, owner.session, secret);
    expect(job?.operation.command).toBe("ls");
    broker.complete(computer.id, owner.session, secret, job!.id, { ok: true });
    await expect(result).resolves.toEqual({ ok: true });

    const gone = new AbortController(); gone.abort();
    const queued = broker.request(command(computer.id), owner.person, () => true);
    await expect(broker.poll(computer.id, owner.session, secret, gone.signal)).resolves.toBeNull();
    const delivered = await broker.poll(computer.id, owner.session, secret);
    expect(delivered?.operation.command).toBe("ls");
    broker.complete(computer.id, owner.session, secret, delivered!.id, { ok: true });
    await expect(queued).resolves.toEqual({ ok: true });
    broker.close();
  });
});

describe("noticing a request whose caller left", () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); server = undefined; });

  const serve = async (onSignal: (signal: AbortSignal, finish: () => void) => void) => {
    server = createServer((_req, res) => onSignal(requestGone(res), () => res.end("{}")));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("aborts when the caller hangs up before the answer, and not after a normal answer", async () => {
    let held: AbortSignal | undefined;
    const answered: AbortSignal[] = [];
    const base = await serve((signal, finish) => {
      if (held === undefined) { held = signal; return; }
      finish();
      answered.push(signal);
    });
    const caller = new AbortController();
    const hanging = fetch(base, { signal: caller.signal }).catch(() => null);
    await vi.waitFor(() => expect(held).toBeDefined());
    expect(held!.aborted).toBe(false);
    caller.abort();
    await hanging;
    await vi.waitFor(() => expect(held!.aborted).toBe(true));

    expect(await (await fetch(base)).text()).toBe("{}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered.map((signal) => signal.aborted)).toEqual([false]);
  });
});
