import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addJob, changeJob, NO_PHONE, PhoneDesk, phoneAdd, phoneChange, phoneDidNotOpen, phoneRead, phoneTooOld, readJob, type PhoneJobKind } from "./phone-desk.ts";

const OWNER = { session: "session-phone", person: "cloud-home" };
const PHONE = "4f6f5c1e-2d4a-4f5b-8c7d-9e0f1a2b3c4d";
const SECRET = "a".repeat(64);
const OTHER_SECRET = "b".repeat(64);
const ALL: PhoneJobKind[] = ["calendar", "reminders", "contacts", "location", "add_calendar_event", "add_reminder"];
const folders: string[] = [];

afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function world(options: { live?: (id: string) => boolean; file?: string } = {}) {
  let clock = 1_000_000;
  const desk = new PhoneDesk(options.live ?? (() => true), { pollMs: 50, jobMs: 2_000, now: () => clock, ...(options.file ? { file: options.file } : {}) });
  return { desk, advance: (ms: number) => { clock += ms; } };
}

const calendar = readJob(phoneRead.parse({ what: "calendar", from: "2026-11-03", to: "2026-11-04" }));
const addEvent = addJob(phoneAdd.parse({ what: "calendar_event", title: "Dentist", start: "2026-11-03T14:30" }));
const never = () => { throw new Error("no notification expected"); };

describe("a dog using the person's phone", () => {
  it("reaches the open phone and brings its answer back", async () => {
    const { desk } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, SECRET);
    const answer = desk.request("cloud-home", calendar, () => true, never);
    const job = await desk.poll(PHONE, OWNER.session, SECRET);
    expect(job).toMatchObject({ kind: "calendar", arguments: { from: "2026-11-03", to: "2026-11-04" } });
    desk.complete(PHONE, OWNER.session, SECRET, { jobId: job!.id, ok: true, result: { events: [{ title: "Standup" }] } });
    await expect(answer).resolves.toEqual({ events: [{ title: "Standup" }] });
  });

  it("says plainly when later.dog has never been open on a phone", async () => {
    const { desk } = world();
    await expect(desk.request("cloud-home", calendar, () => true, never)).rejects.toThrow(NO_PHONE);
    await expect(desk.request(null, calendar, () => true, never)).rejects.toThrow(NO_PHONE);
  });

  it("says the iPhone app needs its next version when the phone can't do that yet", async () => {
    const { desk } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: [] }, OWNER, SECRET);
    await expect(desk.request("cloud-home", calendar, () => true, never)).rejects.toThrow(phoneTooOld("calendar"));
  });

  it("asks the person to open the app when it's closed, then runs the request once it opens", async () => {
    const { desk, advance } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, SECRET);
    advance(60_000);
    const asked: PhoneJobKind[] = [];
    const answer = desk.request("cloud-home", calendar, () => true, (kind) => { asked.push(kind); }, 1_000);
    await Promise.resolve();
    expect(asked).toEqual(["calendar"]);
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, OTHER_SECRET);
    const job = await desk.poll(PHONE, OWNER.session, OTHER_SECRET);
    desk.complete(PHONE, OWNER.session, OTHER_SECRET, { jobId: job!.id, ok: true, result: { events: [] } });
    await expect(answer).resolves.toEqual({ events: [] });
  });

  it("gives up with a clear line when the app isn't opened in time", async () => {
    const { desk, advance } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, SECRET);
    advance(60_000);
    await expect(desk.request("cloud-home", calendar, () => true, () => undefined, 30)).rejects.toThrow(phoneDidNotOpen("calendar", 0));
  });

  it("never adds twice: an add the closed app may have run fails, a read is asked again", async () => {
    const { desk } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, SECRET);
    const added = desk.request("cloud-home", addEvent, () => true, never);
    const read = desk.request("cloud-home", calendar, () => true, never);
    const first = await desk.poll(PHONE, OWNER.session, SECRET);
    const second = await desk.poll(PHONE, OWNER.session, SECRET);
    expect([first?.kind, second?.kind]).toEqual(["add_calendar_event", "calendar"]);
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, OTHER_SECRET);
    await expect(added).rejects.toThrow(/Check whether it was added/);
    const again = await desk.poll(PHONE, OWNER.session, OTHER_SECRET);
    expect(again?.kind).toBe("calendar");
    desk.complete(PHONE, OWNER.session, OTHER_SECRET, { jobId: again!.id, ok: true, result: { events: [] } });
    await expect(read).resolves.toEqual({ events: [] });
  });

  it("passes the phone's own refusal back to the dog", async () => {
    const { desk } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, SECRET);
    const answer = desk.request("cloud-home", calendar, () => true, never);
    const job = await desk.poll(PHONE, OWNER.session, SECRET);
    desk.complete(PHONE, OWNER.session, SECRET, { jobId: job!.id, ok: false, error: "Calendar access is off for later.dog in iPhone Settings." });
    await expect(answer).rejects.toThrow("Calendar access is off for later.dog in iPhone Settings.");
  });

  it("drops a request whose turn ended before the phone took it", async () => {
    const { desk } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, SECRET);
    let active = true;
    const answer = desk.request("cloud-home", calendar, () => active, never);
    const dropped = expect(answer).rejects.toThrow("The requesting turn ended");
    active = false;
    expect(await desk.poll(PHONE, OWNER.session, SECRET)).toBeNull();
    await dropped;
  });

  it("only lets the phone that connected take its work", async () => {
    const { desk } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, SECRET);
    await expect(desk.poll(PHONE, OWNER.session, OTHER_SECRET)).rejects.toThrow(/not authorized/);
    await expect(desk.poll(PHONE, "another-session", SECRET)).rejects.toThrow(/not authorized/);
  });

  it("keeps someone else's phone out of the person's requests", async () => {
    const { desk } = world();
    desk.connect({ id: PHONE, name: "Their iPhone", can: ALL }, { session: "other", person: "someone-else" }, SECRET);
    await expect(desk.request("cloud-home", calendar, () => true, never)).rejects.toThrow(NO_PHONE);
  });

  it("refuses an answer too big to hand to a dog", async () => {
    const { desk } = world();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ALL }, OWNER, SECRET);
    const answer = desk.request("cloud-home", calendar, () => true, never);
    const job = await desk.poll(PHONE, OWNER.session, SECRET);
    desk.complete(PHONE, OWNER.session, SECRET, { jobId: job!.id, ok: true, result: { notes: "x".repeat(300_000) } });
    await expect(answer).rejects.toThrow(/too big/);
  });

  it("remembers the phone across a home restart, and forgets it when its sign-in ends", () => {
    const folder = mkdtempSync(join(tmpdir(), "phone-desk-"));
    folders.push(folder);
    const file = join(folder, "known-phones.json");
    world({ file }).desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ["calendar"] }, OWNER, SECRET);
    expect(world({ file }).desk.status("cloud-home")).toEqual([expect.objectContaining({ id: PHONE, name: "Jacob's iPhone", online: false, can: ["calendar"] })]);
    expect(world({ file, live: () => false }).desk.status("cloud-home")).toEqual([]);
  });
});

describe("what a dog may ask of the phone", () => {
  it("needs a name to look up and a start for an event", () => {
    expect(phoneRead.safeParse({ what: "contacts" }).success).toBe(false);
    expect(phoneAdd.safeParse({ what: "calendar_event", title: "Dentist" }).success).toBe(false);
    expect(phoneAdd.safeParse({ what: "reminder", title: "Call mom" }).success).toBe(true);
  });

  it("takes dates the phone can read in its own time zone, and nothing vague", () => {
    for (const ok of ["2026-11-03", "2026-11-03T14:30", "2026-11-03T14:30:00Z", "2026-11-03T14:30-08:00"]) {
      expect(phoneRead.safeParse({ what: "calendar", from: ok }).success).toBe(true);
    }
    for (const vague of ["tomorrow", "11/3", "2026-11-03 at 2pm"]) {
      expect(phoneRead.safeParse({ what: "calendar", from: vague }).success).toBe(false);
    }
  });

  it("changes an event or a reminder by its id, and only in ways that fit it", () => {
    expect(changeJob(phoneChange.parse({ what: "reminder", id: "r-1", completed: true }))).toEqual({ kind: "change_reminder", arguments: { id: "r-1", completed: true } });
    expect(changeJob(phoneChange.parse({ what: "calendar_event", id: "e-1", start: "2026-11-04T09:00", location: "Suite 200" })))
      .toEqual({ kind: "change_calendar_event", arguments: { id: "e-1", start: "2026-11-04T09:00", location: "Suite 200" } });
    expect(phoneChange.safeParse({ what: "reminder", id: "r-1" }).error?.issues[0]?.message).toMatch(/Say what to change/);
    expect(phoneChange.safeParse({ what: "reminder", id: "r-1", start: "2026-11-04" }).error?.issues[0]?.message).toMatch(/A reminder has due, completed/);
    expect(phoneChange.safeParse({ what: "calendar_event", id: "e-1", completed: true }).error?.issues[0]?.message).toMatch(/An event has title, start/);
    expect(phoneChange.safeParse({ what: "calendar_event", completed: true }).success).toBe(false);
    expect(phoneChange.safeParse({ what: "calendar_event", id: "e-1", start: "tomorrow" }).success).toBe(false);
  });

  it("turns the dog's words into the phone's jobs", () => {
    expect(readJob(phoneRead.parse({ what: "contacts", query: "Ana" }))).toEqual({ kind: "contacts", arguments: { query: "Ana" } });
    expect(addJob(phoneAdd.parse({ what: "reminder", title: "Call mom", due: "2026-11-03T18:00" }))).toEqual({ kind: "add_reminder", arguments: { title: "Call mom", due: "2026-11-03T18:00" } });
  });
});
