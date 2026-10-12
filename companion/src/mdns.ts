import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

import { lanAddresses } from "./listener.ts";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const TTL_HOST = 120;
const TTL_SERVICE = 4500;
const MULTICAST_TTL = 255;
const GOODBYE_FLUSH_MS = 250;

function toIpv4(address: string): number | null {
  const plain = address.replace(/^::ffff:/i, "").split("%")[0];
  const parts = plain.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = out * 256 + octet;
  }
  return out >>> 0;
}

export function isOnLink(from: string, interfaces = networkInterfaces()): boolean {
  const source = toIpv4(from);
  if (source === null) return false;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      const address = toIpv4(entry.address);
      const mask = toIpv4(entry.netmask);
      if (address === null || mask === null) continue;
      if ((((source ^ address) & mask) >>> 0) === 0) return true;
    }
  }
  return false;
}

export const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
const FLUSH = 0x8000;
const QU = 0x8000;
export const SERVICE_ENUMERATION = "_services._dns-sd._udp.local";

export interface Question {
  name: string;
  type: number;
  unicast: boolean;
}

export interface DnsMessage {
  id: number;
  response: boolean;
  questions: Question[];
}

export type ResourceRecord =
  | { name: string; type: 1; data: string }
  | { name: string; type: 12; data: string }
  | { name: string; type: 16; data: string[] }
  | { name: string; type: 33; data: { port: number; target: string } };

export function encodeName(name: string): Buffer {
  const chunks: Buffer[] = [];
  for (const label of name.split(".").filter(Boolean)) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) throw new Error(`label longer than 63 bytes: ${label}`);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function decodeName(buf: Buffer, start: number): { name: string; offset: number } {
  const labels: string[] = [];
  let pos = start;
  let end = start;
  let jumped = false;
  let hops = 0;

  for (;;) {
    if (pos >= buf.length) throw new Error("truncated name");
    const length = buf[pos];
    if (length === 0) {
      if (!jumped) end = pos + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("truncated pointer");
      const target = ((length & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) end = pos + 2;
      jumped = true;
      if (++hops > 16) throw new Error("compression pointer loop");
      pos = target;
      continue;
    }
    const from = pos + 1;
    if (from + length > buf.length) throw new Error("truncated label");
    labels.push(buf.toString("utf8", from, from + length));
    pos = from + length;
    if (!jumped) end = pos;
  }
  return { name: labels.join("."), offset: end };
}

export function decodeMessage(buf: Buffer): DnsMessage | null {
  try {
    if (buf.length < 12) return null;
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    const questionCount = buf.readUInt16BE(4);
    const questions: Question[] = [];
    let offset = 12;
    for (let i = 0; i < questionCount; i++) {
      const decoded = decodeName(buf, offset);
      offset = decoded.offset;
      if (offset + 4 > buf.length) return null;
      const type = buf.readUInt16BE(offset);
      const klass = buf.readUInt16BE(offset + 2);
      offset += 4;
      questions.push({ name: decoded.name, type, unicast: (klass & QU) !== 0 });
    }
    return { id, response: (flags & 0x8000) !== 0, questions };
  } catch {
    return null;
  }
}

function mayFlush(record: ResourceRecord, legacy: boolean): boolean {
  return !legacy && record.type !== TYPE.PTR;
}

function encodeRecord(record: ResourceRecord, ttlOverride: number | undefined, flush: boolean): Buffer {
  let rdata: Buffer;
  let ttl: number;
  switch (record.type) {
    case TYPE.A: {
      const octets = record.data.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        throw new Error(`not an IPv4 address: ${record.data}`);
      }
      rdata = Buffer.from(octets);
      ttl = TTL_HOST;
      break;
    }
    case TYPE.PTR:
      rdata = encodeName(record.data);
      ttl = TTL_SERVICE;
      break;
    case TYPE.TXT: {
      const entries = record.data.map((entry) => {
        const bytes = Buffer.from(entry, "utf8");
        if (bytes.length > 255) throw new Error(`TXT entry longer than 255 bytes: ${entry}`);
        return Buffer.concat([Buffer.from([bytes.length]), bytes]);
      });
      rdata = entries.length ? Buffer.concat(entries) : Buffer.from([0]);
      ttl = TTL_SERVICE;
      break;
    }
    case TYPE.SRV: {
      const header = Buffer.alloc(6);
      header.writeUInt16BE(0, 0);
      header.writeUInt16BE(0, 2);
      header.writeUInt16BE(record.data.port, 4);
      rdata = Buffer.concat([header, encodeName(record.data.target)]);
      ttl = TTL_HOST;
      break;
    }
  }

  const name = encodeName(record.name);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(record.type, 0);
  fixed.writeUInt16BE(flush ? CLASS_IN | FLUSH : CLASS_IN, 2);
  fixed.writeUInt32BE(ttlOverride ?? ttl, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, fixed, rdata]);
}

export function encodeResponse(
  answers: ResourceRecord[],
  additionals: ResourceRecord[] = [],
  opts: { id?: number; ttl?: number; questions?: Question[]; legacy?: boolean } = {},
): Buffer {
  const questions = opts.questions ?? [];
  const legacy = opts.legacy ?? false;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.id ?? 0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);

  const questionBytes = questions.map((question) => {
    const suffix = Buffer.alloc(4);
    suffix.writeUInt16BE(question.type, 0);
    suffix.writeUInt16BE(CLASS_IN, 2);
    return Buffer.concat([encodeName(question.name), suffix]);
  });

  return Buffer.concat([
    header,
    ...questionBytes,
    ...answers.map((record) => encodeRecord(record, opts.ttl, mayFlush(record, legacy))),
    ...additionals.map((record) => encodeRecord(record, opts.ttl, mayFlush(record, legacy))),
  ]);
}

export interface ServiceInfo {
  name: string;
  type: string;
  port: number;
  host: string;
  addresses: string[];
  txt: string[];
}

const recordKey = (record: ResourceRecord) =>
  `${record.name.toLowerCase()}|${record.type}|${JSON.stringify(record.data)}`;

function dedupe(records: ResourceRecord[], exclude: ResourceRecord[] = []): ResourceRecord[] {
  const seen = new Set(exclude.map(recordKey));
  const out: ResourceRecord[] = [];
  for (const record of records) {
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

export function serviceRecords(service: ServiceInfo) {
  const serviceName = `${service.type}.local`;
  const instance = `${service.name}.${serviceName}`;
  return {
    serviceName,
    instance,
    ptr: { name: serviceName, type: TYPE.PTR, data: instance } as ResourceRecord,
    srv: {
      name: instance,
      type: TYPE.SRV,
      data: { port: service.port, target: service.host },
    } as ResourceRecord,
    txt: { name: instance, type: TYPE.TXT, data: service.txt } as ResourceRecord,
    addresses: service.addresses.map(
      (address) => ({ name: service.host, type: TYPE.A, data: address }) as ResourceRecord,
    ),
  };
}

export function announcement(service: ServiceInfo): ResourceRecord[] {
  const { ptr, srv, txt, addresses } = serviceRecords(service);
  return [ptr, srv, txt, ...addresses];
}

export function answersFor(
  message: DnsMessage,
  service: ServiceInfo,
): { answers: ResourceRecord[]; additionals: ResourceRecord[] } {
  if (message.response) return { answers: [], additionals: [] };
  const { serviceName, instance, ptr, srv, txt, addresses } = serviceRecords(service);
  const answers: ResourceRecord[] = [];
  const additionals: ResourceRecord[] = [];

  for (const question of message.questions) {
    const name = question.name.toLowerCase();
    const asks = (type: number) => question.type === type || question.type === TYPE.ANY;

    if (name === SERVICE_ENUMERATION && asks(TYPE.PTR)) {
      answers.push({ name: SERVICE_ENUMERATION, type: TYPE.PTR, data: serviceName });
    } else if (name === serviceName.toLowerCase() && asks(TYPE.PTR)) {
      answers.push(ptr);
      additionals.push(srv, txt, ...addresses);
    } else if (name === instance.toLowerCase()) {
      if (asks(TYPE.SRV)) {
        answers.push(srv);
        additionals.push(...addresses);
      }
      if (asks(TYPE.TXT)) answers.push(txt);
    } else if (name === service.host.toLowerCase() && asks(TYPE.A)) {
      answers.push(...addresses);
    }
  }

  const deduped = dedupe(answers);
  return { answers: deduped, additionals: dedupe(additionals, deduped) };
}

export function dnsLabel(text: string, fallback = "later.dog"): string {
  let label = text
    // oxlint-disable-next-line no-control-regex -- control characters are not valid in a DNS label
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\./g, " ")
    .trim();
  while (Buffer.byteLength(label, "utf8") > 63) label = label.slice(0, -1).trimEnd();
  return label || fallback;
}

export function clampBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let out = "";
  let size = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    if (size + width > limit) break;
    out += character;
    size += width;
  }
  return out;
}

export function defaultHostName(machine = hostname()): string {
  const digest = createHash("sha256").update(machine).digest("hex").slice(0, 8);
  return `laterdog-${digest}.local`;
}

export function advertisableAddresses(): string[] {
  return lanAddresses();
}

export interface ResponderSocket {
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (message: Buffer, remote: { address: string; port: number }) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  bind(port: number, callback?: () => void): void;
  setMulticastTTL(ttl: number): void;
  addMembership(group: string, membershipInterface?: string): void;
  setMulticastInterface(multicastInterface: string): void;
  send(packet: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void;
  close(callback?: () => void): void;
  address(): { port: number };
}

export interface ResponderOptions {
  port?: number;
  multicast?: boolean;
  socketFactory?: () => ResponderSocket;
}

export class MdnsResponder {
  private socket: ResponderSocket | null = null;
  private service: ServiceInfo | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private sendQueue: Promise<void> = Promise.resolve();
  private readonly port: number;
  private readonly multicast: boolean;
  private readonly socketFactory: () => ResponderSocket;

  constructor(options: ResponderOptions = {}) {
    this.port = options.port ?? MDNS_PORT;
    this.multicast = options.multicast ?? true;
    this.socketFactory = options.socketFactory ?? (() => createSocket({ type: "udp4", reuseAddr: true }));
  }

  get advertising(): boolean {
    return this.socket !== null;
  }

  address(): number | null {
    try {
      return this.socket?.address().port ?? null;
    } catch {
      return null;
    }
  }

  async advertise(service: ServiceInfo): Promise<boolean> {
    await this.stop();
    if (!service.addresses.length) return false;

    const socket = this.socketFactory();
    socket.on("error", () => void this.stop());
    socket.on("message", (buf, remote) => this.handle(buf, remote.address, remote.port));

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(this.port, () => resolve());
      });
    } catch {
      try {
        socket.close();
      } catch {}
      return false;
    }

    if (this.multicast) {
      try {
        socket.setMulticastTTL(MULTICAST_TTL);
      } catch {}
      let joined = false;
      for (const address of service.addresses) {
        try {
          socket.addMembership(MDNS_ADDRESS, address);
          joined = true;
        } catch {}
      }
      if (!joined) {
        try {
          socket.addMembership(MDNS_ADDRESS);
        } catch {}
      }
    }

    this.socket = socket;
    this.service = service;
    for (const delay of [0, 1000, 3000]) {
      const timer = setTimeout(() => this.announce(), delay);
      timer.unref?.();
      this.timers.push(timer);
    }
    return true;
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
    const socket = this.socket;
    const service = this.service;
    this.socket = null;
    this.service = null;
    if (!socket) return;
    if (service) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, GOODBYE_FLUSH_MS);
        timer.unref?.();
        try {
          this.send(socket, encodeResponse(announcement(service), [], { ttl: 0 }), service.addresses, () => {
            clearTimeout(timer);
            finish();
          });
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
    }
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private announce() {
    if (!this.socket || !this.service) return;
    try {
      this.send(this.socket, encodeResponse(announcement(this.service)), this.service.addresses);
    } catch {}
  }

  private handle(buf: Buffer, from: string, fromPort: number) {
    if (!this.socket || !this.service) return;
    if (!isOnLink(from)) return;
    const message = decodeMessage(buf);
    if (!message || message.response || !message.questions.length) return;
    const { answers, additionals } = answersFor(message, this.service);
    if (!answers.length) return;

    const legacy = fromPort !== MDNS_PORT;
    const unicast = legacy || message.questions.some((question) => question.unicast);
    const packet = encodeResponse(
      answers,
      additionals,
      legacy ? { id: message.id, questions: message.questions, legacy: true } : {},
    );
    try {
      if (unicast) this.socket.send(packet, fromPort, from);
      else this.send(this.socket, packet, this.service.addresses);
    } catch {}
  }

  private send(
    socket: ResponderSocket,
    packet: Buffer,
    addresses: string[],
    done?: (error: Error | null) => void,
  ) {
    if (!this.multicast) {
      done?.(null);
      return;
    }
    this.sendQueue = this.sendQueue.then(async () => {
      for (const address of addresses) {
        await new Promise<void>((resolve) => {
          try {
            socket.setMulticastInterface(address);
          } catch {
            resolve();
            return;
          }
          try {
            socket.send(packet, MDNS_PORT, MDNS_ADDRESS, () => resolve());
          } catch {
            resolve();
          }
        });
      }
      done?.(null);
    });
  }
}
