import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { WorkspaceStore } from "./store.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const assistanceSchema = z.object({ deviceId: z.string().uuid(), root: z.string().min(1).max(1000),
  kind: z.enum(["inspect_repo", "assist"]), instructions: z.string().max(50_000).default("") }).strict();
export interface Device { id: string; label: string; roots: string[]; allowAssistance: boolean; lastSeen: string | null; revoked: boolean }
export interface BridgeRequest extends z.infer<typeof assistanceSchema> {
  id: string; state: "queued" | "claimed" | "done" | "needs_attention"; createdAt: string; result?: unknown;
  /** The dog whose token queued it (dog-access.ts); a dog reads only its own requests and unowned ones. */
  requestedBy?: string;
}
interface DeviceRow { id: string; label: string; roots: string; last_seen: string | null; revoked: number }
export class BridgeStore {
  private readonly store: WorkspaceStore;
  constructor(store: WorkspaceStore) { this.store = store; }
  pairing(roots: string[], allowAssistance = false): { code: string; expiresAt: string } {
    if (!roots.length || roots.some((root) => !isAbsolute(root))) throw new Error("Pairing needs explicit absolute repository roots");
    const code = randomBytes(24).toString("base64url"); const expires = Date.now() + 300_000;
    this.store.db.prepare("DELETE FROM pairing WHERE expires < ?").run(Date.now());
    this.store.db.prepare("INSERT INTO pairing VALUES(?,?,?)").run(hash(code), expires, JSON.stringify({ roots, allowAssistance }));
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  pair(code: string, label: string): { deviceId: string; token: string; roots: string[]; allowAssistance: boolean } {
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT roots,expires FROM pairing WHERE hash=?").get(hash(code)) as { roots: string; expires: number } | undefined;
      if (!row || row.expires < Date.now()) throw Object.assign(new Error("Pairing code expired or was already used"), { status: 403 });
      const settings = JSON.parse(row.roots) as { roots: string[]; allowAssistance: boolean };
      const token = randomBytes(32).toString("base64url"); const deviceId = randomUUID();
      this.store.db.prepare("DELETE FROM pairing WHERE hash=?").run(hash(code));
      this.store.db.prepare("INSERT INTO devices(id,label,token_hash,roots) VALUES(?,?,?,?)").run(deviceId, label, hash(token), JSON.stringify(settings));
      return { deviceId, token, ...settings };
    });
  }
  private view(row: DeviceRow): Device {
    const settings = JSON.parse(row.roots) as { roots: string[]; allowAssistance: boolean };
    return { id: row.id, label: row.label, ...settings, lastSeen: row.last_seen, revoked: Boolean(row.revoked) };
  }
  devices(): Device[] { return (this.store.db.prepare("SELECT id,label,roots,last_seen,revoked FROM devices").all() as unknown as DeviceRow[]).map((r) => this.view(r)); }
  authenticate(token: string): Device | undefined {
    const row = this.store.db.prepare("SELECT id,label,roots,last_seen,revoked FROM devices WHERE token_hash=? AND revoked=0").get(hash(token)) as DeviceRow | undefined;
    return row ? this.view(row) : undefined;
  }
  revoke(id: string): void { this.store.db.prepare("UPDATE devices SET revoked=1 WHERE id=?").run(id); }
  requests(): BridgeRequest[] { return (this.store.db.prepare("SELECT document FROM bridge_requests ORDER BY rowid DESC LIMIT 200").all() as { document: string }[]).map((r) => JSON.parse(r.document) as BridgeRequest); }
  create(input: unknown, requestedBy?: string): BridgeRequest {
    const request = assistanceSchema.parse(input); const device = this.devices().find((d) => d.id === request.deviceId && !d.revoked);
    if (!device || !device.roots.includes(request.root) || (request.kind === "assist" && !device.allowAssistance)) throw Object.assign(new Error("This device has not granted that repository or assistance capability"), { status: 403 });
    const result: BridgeRequest = { ...request, ...(requestedBy ? { requestedBy } : {}), id: randomUUID(), state: "queued", createdAt: new Date().toISOString() };
    this.store.db.prepare("INSERT INTO bridge_requests VALUES(?,?)").run(result.id, JSON.stringify(result)); return result;
  }
  poll(device: Device): BridgeRequest | null {
    this.store.db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(new Date().toISOString(), device.id);
    const row = this.store.db.prepare("SELECT document FROM bridge_requests WHERE json_extract(document,'$.deviceId')=? AND json_extract(document,'$.state') IN ('queued','claimed') ORDER BY rowid LIMIT 1").get(device.id) as { document: string } | undefined;
    const request = row ? JSON.parse(row.document) as BridgeRequest : undefined;
    if (!request) return null;
    request.state = "claimed"; this.store.db.prepare("UPDATE bridge_requests SET document=? WHERE id=?").run(JSON.stringify(request), request.id); return request;
  }
  result(device: Device, id: string, result: unknown, failed: boolean): BridgeRequest {
    const row = this.store.db.prepare("SELECT document FROM bridge_requests WHERE id=? AND json_extract(document,'$.deviceId')=?").get(id,device.id) as { document: string } | undefined;
    const request = row ? JSON.parse(row.document) as BridgeRequest : undefined;
    if (!request) throw Object.assign(new Error("Bridge request not found"), { status: 404 });
    if (["done", "needs_attention"].includes(request.state)) return request;
    request.state = failed ? "needs_attention" : "done"; request.result = result;
    this.store.db.prepare("UPDATE bridge_requests SET document=? WHERE id=?").run(JSON.stringify(request), id); return request;
  }
}
