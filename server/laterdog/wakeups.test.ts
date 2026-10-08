import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createJobSchema, type Wakeup } from '../../shared/laterdog.ts';
import { WorkspaceStore } from './store.ts';
import { Supervisor } from './supervisor.ts';
import { WAKEUP_BOTS_HEADER, createSupervisorServer, wakeupReport } from './http.ts';
import { DOG_HEADER, dogToken } from './dog-access.ts';
import { settlementFor, startWakeupPull, wakeupPullActive, type WakeupPull } from './wakeups.ts';
import { WAKEUP_BOTS_HEADER as WORKER_HEADER, mayHaveWakeups } from '../../deploy/laterdog/cloudflare/src/wakeup-hint.ts';

// A supervisor that cannot call the desktop (hosted) keeps each wake-up until the desktop pulls and settles it. Synthetic
// boundaries only: the supervisor never ticks, so no codex, gh or git process starts, and nothing leaves loopback.
const TOKEN = 'fixture-admin-token-'.repeat(3);
const resources: { server: Server; supervisor: Supervisor; store: WorkspaceStore; dir: string; pull?: WakeupPull }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const r of resources.splice(0)) { r.pull?.stop(); r.supervisor.stop(); await r.supervisor.drain(); await new Promise<void>((resolve) => r.server.close(() => resolve())); r.store.close(); rmSync(r.dir,{ recursive:true,force:true }); }
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'laterdog-wakeups-')); const store = new WorkspaceStore(join(dir,'workspace.sqlite'));
  const supervisor = new Supervisor(store,{ dataDir:dir,profiles:[{ id:'default',label:'Fixture' }],concurrency:4,publishingHost:'remote' });
  const server = createSupervisorServer(supervisor,TOKEN); const resource: (typeof resources)[number] = { server,supervisor,store,dir }; resources.push(resource);
  server.listen(0,'127.0.0.1'); await once(server,'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  store.saveRepository({ slug:'fixture/repo',environmentId:'synthetic-cloud',generation:'unqualified',baseRef:'main',publish:true,merge:false,behavioralChecks:[],verification:[] } as never);
  // A job a dog delegated from one of its conversations; each later milestone queues one wake-up for that conversation.
  const delegated = (botId: string, threadId: string) => store.create(createJobSchema.parse({ requestKey:randomUUID(),repository:'fixture/repo',title:'Fixture job',brief:'Synthetic work',botId,conversationId:threadId }));
  const post = async (path: string, body: unknown, headers: Record<string,string> = { authorization:`Bearer ${TOKEN}` }) => {
    const response = await fetch(`${origin}/v1${path}`,{ method:'POST',headers:{ 'content-type':'application/json',...headers },body:JSON.stringify(body) });
    return { status:response.status,report:response.headers.get(WAKEUP_BOTS_HEADER),body:await response.json() as Record<string,unknown> };
  };
  return { origin,store,supervisor,delegated,post,resource };
}

it('keeps each wake-up for its dog until a desktop settles it, and reports which dogs have one waiting', async () => {
  const { store,delegated,post } = await fixture();
  const mine = delegated('bot-mine','thread-mine'); const other = delegated('bot-other','thread-other');
  store.update(mine.id,{ state:'ready' },'collected','Synthetic diff retained');
  store.update(other.id,{ state:'ready' },'collected','Another dog’s diff');
  store.update(mine.id,{ state:'needs_attention',blocker:'Synthetic blocker' },'publication_blocked','Synthetic blocker');

  const pulled = await post('/wakeups/pull',{ bots:['bot-mine'] });
  expect(pulled.status).toBe(200);
  const wakeups = pulled.body.wakeups as Wakeup[];
  // Only this desktop's dog, oldest first, each with the send id that makes a repeat harmless.
  expect(wakeups.map((w) => w.botId)).toEqual(['bot-mine','bot-mine']);
  expect(wakeups.map((w) => w.text.split('. ')[0])).toEqual([`later.dog job ${mine.id}: collected`,`later.dog job ${mine.id}: publication_blocked`]);
  expect(wakeups.every((w) => w.threadId === 'thread-mine' && /^[A-Za-z0-9_-]{16,80}$/.test(w.sendId))).toBe(true);
  expect(JSON.parse(pulled.report ?? '')).toEqual(['bot-mine','bot-other']);

  expect((await post(`/wakeups/${wakeups[0].id}`,{ outcome:'delivered' })).body).toEqual({ settled:true });
  // Settling twice is harmless: the second answer says nothing changed.
  expect((await post(`/wakeups/${wakeups[0].id}`,{ outcome:'delivered' })).body).toEqual({ settled:false });
  const dropped = await post(`/wakeups/${wakeups[1].id}`,{ outcome:'dropped',reason:'the dog switched tasks before it could receive the message' });
  expect(dropped.body).toEqual({ settled:true });
  // The reason stays visible on the job; this dog has nothing left waiting, the other dog still does.
  expect(store.events(mine.id).find((e) => e.type === 'wakeup_dropped')?.detail).toBe('the dog switched tasks before it could receive the message');
  expect(JSON.parse(dropped.report ?? '')).toEqual(['bot-other']);
  expect((await post('/wakeups/pull',{ bots:['bot-mine'] })).body).toEqual({ wakeups:[] });
  expect(store.db.prepare('SELECT delivered FROM outbox ORDER BY id').all()).toEqual([{ delivered:1 },{ delivered:0 },{ delivered:2 }]);
});

it('keeps the wake-up queue away from dog tokens', async () => {
  const { delegated,store,post } = await fixture();
  const job = delegated('bot-mine','thread-mine'); store.update(job.id,{ state:'ready' },'collected','Synthetic diff retained');
  const asDog = { authorization:`Bearer ${dogToken(TOKEN,'bot-mine')}`,[DOG_HEADER]:'bot-mine' };
  for (const [path,body] of [['/wakeups/pull',{ bots:['bot-mine'] }],['/wakeups/1',{ outcome:'delivered' }]] as const) {
    const refused = await post(path,body,asDog);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("This dog's access does not include the wake-up queue; the later.dog desktop delivers each conversation's wake-ups.");
    expect(refused.report).toBeNull();
  }
  expect(store.db.prepare('SELECT delivered FROM outbox').all()).toEqual([{ delivered:0 }]);
});

it('lets the hosted Worker answer a pull itself only when the supervisor reported nothing waiting for those dogs', () => {
  expect(WORKER_HEADER).toBe(WAKEUP_BOTS_HEADER);
  const pull = (bots: string[]) => JSON.stringify({ bots });
  expect(mayHaveWakeups(wakeupReport([]),pull(['a']))).toBe(false);
  expect(mayHaveWakeups(wakeupReport(['b']),pull(['a']))).toBe(false);
  expect(mayHaveWakeups(wakeupReport(['a','b']),pull(['a']))).toBe(true);
  // Anything the Worker cannot judge goes to the supervisor: no report yet, too many to list, a malformed body or report.
  expect(mayHaveWakeups(undefined,pull(['a']))).toBe(true);
  expect(wakeupReport(Array.from({ length:51 },(_,i) => `bot-${i}`))).toBe('*');
  expect(mayHaveWakeups('*',pull(['a']))).toBe(true);
  expect(mayHaveWakeups(wakeupReport(['a']),'{')).toBe(true);
  expect(mayHaveWakeups('not json',pull(['a']))).toBe(true);
});

it('settles a refused wake-up by what refused it', () => {
  const refusal = (status: number, code?: string) => Object.assign(new Error(code === 'spend_cap' ? 'Spend limit reached' : 'the dog switched tasks before it could receive the message'),{ status,body:code ? { code } : {} });
  expect(settlementFor(refusal(409))).toEqual({ outcome:'dropped',reason:'the dog switched tasks before it could receive the message' });
  expect(settlementFor(refusal(404))).toMatchObject({ outcome:'dropped' });
  // A spend cap clears when the person raises it, and a restart or a busy store passes: those wait.
  expect(settlementFor(refusal(409,'spend_cap'))).toBeUndefined();
  expect(settlementFor(new Error('database is locked'))).toBeUndefined();
});

it('pulls this desktop’s wake-ups from a hosted supervisor, hands each to its conversation and settles it', async () => {
  const { origin,store,delegated,resource } = await fixture();
  const delivered = delegated('bot-mine','thread-mine'); const gone = delegated('bot-mine','thread-gone'); const capped = delegated('bot-capped','thread-capped');
  for (const job of [delivered,gone,capped]) store.update(job.id,{ state:'ready' },'collected','Synthetic diff retained');
  const unknown = delegated('bot-elsewhere','thread-elsewhere'); store.update(unknown.id,{ state:'ready' },'collected','Another desktop’s dog');
  vi.stubEnv('LATERDOG_SUPERVISOR_URL',origin); vi.stubEnv('LATERDOG_TOKEN',TOKEN);
  const sent: Wakeup[] = [];
  const send = vi.fn(async (wakeup: Wakeup) => {
    if (wakeup.threadId === 'thread-gone') throw Object.assign(new Error('the dog switched tasks before it could receive the message'),{ status:409,body:{} });
    if (wakeup.botId === 'bot-capped') throw Object.assign(new Error('Spend limit reached'),{ status:409,body:{ code:'spend_cap' } });
    sent.push(wakeup);
  });
  const lines: string[] = [];
  const pull = startWakeupPull({ bots:() => ['bot-mine','bot-capped'],send,intervalMs:3_600_000,log:(line) => lines.push(line) });
  if (!pull) throw new Error('A hosted connection must start pulling');
  resource.pull = pull;
  expect(wakeupPullActive()).toBe(true);

  expect(await pull.pull()).toBe(1);
  expect(sent.map((w) => w.threadId)).toEqual(['thread-mine']);
  const states = store.db.prepare('SELECT job_id AS jobId,delivered FROM outbox ORDER BY id').all() as { jobId: string; delivered: number }[];
  // Delivered, dropped with its reason, waiting for the spend cap, and another desktop's dog left alone.
  expect(states.map((s) => s.delivered)).toEqual([1,2,0,0]);
  expect(store.events(gone.id).some((e) => e.type === 'wakeup_dropped')).toBe(true);
  expect(lines).toEqual([expect.stringContaining('waits: Spend limit reached')]);

  // Once the cap is raised the same wake-up goes through; a second pull finds nothing new.
  send.mockImplementation(async (wakeup: Wakeup) => { sent.push(wakeup); });
  expect(await pull.pull()).toBe(1);
  expect(await pull.pull()).toBe(0);
  expect(sent.map((w) => w.threadId)).toEqual(['thread-mine','thread-capped']);
  pull.stop();
  expect(wakeupPullActive()).toBe(false);
});

it('leaves wake-ups to the local supervisor, which calls the desktop itself', () => {
  vi.stubEnv('LATERDOG_SUPERVISOR_URL',''); vi.stubEnv('LATERDOG_HOME',mkdtempSync(join(tmpdir(),'laterdog-wakeups-local-')));
  expect(startWakeupPull({ bots:() => ['bot-mine'],send:vi.fn() })).toBeUndefined();
  expect(wakeupPullActive()).toBe(false);
});
