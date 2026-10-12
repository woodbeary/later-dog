import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const CLOUD_PERSONAL_REFUSAL = "My Cloud is personal: only your own devices can connect.";

const KEY = /^p_[\w-]{22}$/;
const keys = z.array(z.string().regex(KEY)).max(100_000);
const recordFile = z.object({
  version: z.literal(2),
  machineId: z.string().max(128),
  revokedKeys: keys,
  adoptedKeys: keys,
  provenKeys: keys,
  settled: z.boolean(),
  pendingRestore: z.string().max(128).optional(),
  settledRestore: z.string().max(128).optional(),
}).strict();
type OwnershipRecord = z.infer<typeof recordFile>;

export interface PeopleRecord {
  people(): Iterable<string>;
  reassign(move: (person: string) => boolean, to: string): string[];
}

export interface CloudOwnershipOptions {
  file: string;
  machineId: string;
  ownerKey: string;
  nobodyKey: string;
  sessions: {
    list(): readonly { id: string; email?: string; scopes: readonly string[] }[];
    revoke(id: string): boolean;
  };
  personKey(session: { id: string; email?: string }): string;
  starters: PeopleRecord;
  writers: PeopleRecord;
  routines: {
    ids(): Iterable<string>; writer(id: string): string | undefined; fingerprinted(id: string): boolean; resultsOpener(id: string): string | undefined;
    shape(id: string): string | undefined;
    name(id: string, person: string): void; pause(ids: readonly string[]): void;
  };
  unpin(threadIds: readonly string[]): void;
  lines(): { senders: Iterable<string>; answerers: Iterable<string>; approvals: Iterable<[routineId: string, person: string, shape: string]> };
  restoredNow?: string;
  lastRestore?: string;
  log(line: string): void;
}

export interface CloudOwnership {
  adopted: ReadonlySet<string>;
  proven: ReadonlySet<string>;
}

function readRecord(options: CloudOwnershipOptions): OwnershipRecord & { fresh?: true } {
  const fresh: OwnershipRecord & { fresh?: true } = { version: 2, machineId: options.machineId, revokedKeys: [], adoptedKeys: [], provenKeys: [], settled: false, fresh: true };
  let stat;
  try { stat = lstatSync(options.file, { throwIfNoEntry: false }); } catch { stat = null; }
  if (stat === undefined) return fresh;
  try {
    if (!stat || !stat.isFile() || stat.size > 16_000_000) throw new Error("not a file");
    const record = recordFile.parse(JSON.parse(readFileSync(options.file, "utf8")));
    if (record.machineId !== options.machineId) {
      options.log(`cloud home: ${options.file} is another machine's; settling this one's own`);
      return fresh;
    }
    return record;
  } catch {
    options.log(`cloud home: ${options.file} is unreadable, so nothing from before is treated as the owner's`);
    return { ...fresh, settled: true };
  }
}

function save(options: CloudOwnershipOptions, record: OwnershipRecord): boolean {
  try {
    writeFileAtomic(options.file, JSON.stringify(record), { mode: 0o600 });
    return true;
  } catch (error) {
    options.log(`cloud home: could not record who is the owner (${error instanceof Error ? error.message : String(error)}); trying again at the next start`);
    return false;
  }
}

function attempt<T>(options: CloudOwnershipOptions, what: string, step: () => T, fallback: T, failed?: () => void): T {
  try { return step(); } catch (error) {
    options.log(`cloud home: could not ${what} (${error instanceof Error ? error.message : String(error)})`);
    failed?.();
    return fallback;
  }
}

function settledSets(record: OwnershipRecord): CloudOwnership {
  const revoked = new Set(record.revokedKeys);
  return { adopted: new Set(record.adoptedKeys.filter((key) => !revoked.has(key))), proven: new Set(record.provenKeys.filter((key) => !revoked.has(key))) };
}

export function settleCloudOwnership(options: CloudOwnershipOptions): CloudOwnership {
  const { fresh, ...read } = readRecord(options);
  let record: OwnershipRecord = read;
  const others = options.sessions.list().filter((session) => !session.scopes.includes("admin"));
  const revoked = new Set([...record.revokedKeys, ...others.map((session) => options.personKey(session))]);
  const restore = options.restoredNow ??
    (!fresh && options.lastRestore && options.lastRestore !== record.settledRestore && options.lastRestore !== record.pendingRestore ? options.lastRestore : undefined);
  record = { ...record, revokedKeys: [...revoked], ...(restore ? { pendingRestore: restore } : {}),
    ...(fresh && !options.restoredNow && options.lastRestore ? { settledRestore: options.lastRestore } : {}) };
  if (!save(options, record)) return settledSets(record);
  let count = 0;
  for (const session of others) if (attempt(options, "revoke a session", () => options.sessions.revoke(session.id), false)) count += 1;
  options.log(`cloud home: revoked ${count} session${count === 1 ? "" : "s"} that ${count === 1 ? "was" : "were"} not the owner's own device${count === 1 ? "" : "s"}`);
  const orphans = attempt(options, "mark conversations as nobody's", () => options.starters.reassign((person) => revoked.has(person), options.nobodyKey), []);
  if (orphans.length) attempt(options, "unpin their folders", () => options.unpin(orphans), undefined);
  const stopped = attempt(options, "mark routines as nobody's", () => options.writers.reassign((person) => revoked.has(person), options.nobodyKey), []);
  if (stopped.length) attempt(options, "pause their routines", () => options.routines.pause(stopped), undefined);
  if (fresh) {
    options.log("cloud home: only your own devices can connect now. Review the signed-in devices (GET /api/auth/sessions) and sign out any device that isn't yours (DELETE /api/auth/sessions/ID).");
  }
  const restoring = record.pendingRestore !== undefined;
  if (record.settled && !restoring) return settledSets(record);
  const eligible = (person: string) => KEY.test(person) && person !== options.ownerKey && person !== options.nobodyKey && !revoked.has(person);
  let complete = true;
  const incomplete = () => { complete = false; };
  const lines = attempt(options, "read who wrote in each conversation", () => options.lines(), { senders: [], answerers: [], approvals: [] }, incomplete);
  const admins = options.sessions.list().filter((session) => session.scopes.includes("admin")).map((session) => options.personKey(session));
  const proven = new Set([...record.provenKeys, ...admins, ...lines.answerers].filter(eligible));
  const adopted = new Set([...record.adoptedKeys, ...proven, ...options.starters.people(), ...lines.senders].filter(eligible));
  record = { ...record, adoptedKeys: [...adopted], provenKeys: [...proven] };
  if (!save(options, record)) return settledSets(record);
  const moved = attempt(options, "name the owner on their conversations", () => options.starters.reassign((person) => proven.has(person), options.ownerKey), [], incomplete).length;
  const ownersKey = (person: string | undefined) => person !== undefined && (person === options.ownerKey || proven.has(person));
  const approved = new Set<string>();
  for (const [id, person, shape] of lines.approvals) {
    if (ownersKey(person) && options.routines.shape(id) === shape) approved.add(id);
  }
  let owners = 0, nobodys = 0;
  attempt(options, "name each routine's writer", () => {
    for (const id of options.routines.ids()) {
      const writer = options.routines.writer(id);
      const opener = options.routines.resultsOpener(id);
      const owner = writer === options.ownerKey || options.routines.fingerprinted(id) || approved.has(id) ||
        (restoring && writer !== options.nobodyKey && !(writer !== undefined && revoked.has(writer)) && (opener === undefined || ownersKey(opener)));
      if (writer !== (owner ? options.ownerKey : options.nobodyKey)) options.routines.name(id, owner ? options.ownerKey : options.nobodyKey);
      if (owner) owners += 1; else nobodys += 1;
    }
  }, undefined, incomplete);
  if (!complete) return settledSets(record);
  const { pendingRestore: done, ...rest } = record;
  record = { ...rest, settled: true, ...(done ? { settledRestore: done } : {}) };
  save(options, record);
  options.log(`cloud home: settled what came before${restoring ? " (a restore)" : ""}: ${adopted.size} earlier device key${adopted.size === 1 ? "" : "s"} (${proven.size} proven), ${moved} conversation${moved === 1 ? "" : "s"} named the owner's, ${owners} routine${owners === 1 ? "" : "s"} the owner's and ${nobodys} nobody's`);
  return settledSets(record);
}
