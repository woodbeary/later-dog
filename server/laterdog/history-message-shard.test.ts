import { combinedRecallStats, type RecallCorpus } from "../../shared/history-recall.ts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initializeHistoryShard } from "../../deploy/laterdog/home/src/history-schema.ts";
import {
  executeHistoryOperation,
  initializeHistoryMessageIndex,
  storeHistoryMessageValues,
} from "../../shared/history-message-operations.ts";
import { readHistoryValue, type HistorySql } from "../../shared/history-values.ts";
import type { HistoryOperation } from "../../shared/history-shard-types.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: HistorySql = {
    exec(query, ...args) {
      return db.prepare(query).all(...args.map((a) => (a instanceof ArrayBuffer ? new Uint8Array(a) : a))) as never;
    },
  };
  initializeHistoryShard(sql);
  initializeHistoryMessageIndex(sql);
  let n = 2 ** 40;
  return { db, sql, run: (op: HistoryOperation) => executeHistoryOperation(sql, "thread", op, () => String(++n)) };
}
const message = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  at: 4,
  role: "user",
  kind: "text",
  ...extra,
});
describe("sharded conversation operations", () => {
  it("keeps the first row order, follows the chosen branch and serializes conditional imports", () => {
    const { db, run } = fixture();
    const first = message("a", "start");
    run({ op: "messages.import", messages: [first], leaf: "a" });
    run({ op: "messages.append", message: message("b", "left", { parentId: "a" }) });
    run({ op: "messages.append", message: message("c", "right", { parentId: "a" }) });
    run({ op: "messages.update", message: message("b", "edited", { parentId: "a" }) });
    run({ op: "messages.update", message: message("absent", "lost") });
    run({ op: "messages.leaf", leaf: "b" });
    expect(run({ op: "messages.page", backward: true, limit: 2 })).toMatchObject({
      messages: [{ id: "c" }, { id: "b", text: "edited" }],
      hasMore: true,
      activeLeafId: "b",
    });
    expect(() => run({ op: "messages.import", messages: [], leaf: null })).toThrow("existing conversation");
    run({ op: "messages.delete" });
    expect(run({ op: "messages.page" })).toEqual({ messages: [], activeLeafId: null, hasMore: false, next: null });
    db.close();
  });
  it("returns the original command after recovery with an older coordinator and a new generated message ID", () => {
    const { db, run } = fixture(),
      key = "a".repeat(64);
    const first = message("original", "accepted");
    expect(
      run({
        op: "messages.command",
        key,
        result: JSON.stringify(first),
        operations: [{ op: "messages.append", message: first }],
      }),
    ).toBe(JSON.stringify(first));
    run({ op: "messages.append", message: message("newer", "after") });
    const replacement = message("regenerated", "accepted");
    const recovered = run({
      op: "messages.command",
      key,
      result: JSON.stringify(replacement),
      operations: [{ op: "messages.append", message: replacement }],
    });
    expect(recovered).toBe(JSON.stringify(first));
    expect(run({ op: "messages.page" })).toMatchObject({
      messages: [{ id: "original" }, { id: "newer" }],
      activeLeafId: "newer",
    });
    db.close();
  });
  it("merges sharded full-text rankings in the same order and with the same scores as one SQLite corpus", () => {
    const legacy = fixture(),
      small = fixture(),
      large = fixture();
    const docs = [
      ["small", "one", "rare common"],
      ["small", "two", "rare common common common"],
      ["large", "three", "rare rare common"],
      ["large", "four", "rare common detail detail detail"],
    ];
    for (let i = 0; i < 100; i++)
      docs.push(["large", "extra-" + i, "common ".repeat((i % 4) + 1) + "other ".repeat(i % 9)]);
    for (const [group, id, body] of docs) {
      const doc = { op: "messages.insert", message: message(id, body) };
      legacy.run(doc);
      (group === "small" ? small : large).run(doc);
    }
    try {
      const terms = ['"rare"', '"common"'],
        op = { op: "messages.recallStats", terms };
      const corpus = combinedRecallStats([small.run(op), large.run(op)] as RecallCorpus[], terms.length);
      const query = { op: "messages.recall", terms, match: terms.join(" "), corpus };
      type Hit = { id: string; score: number };
      const hits = [...(small.run(query) as Hit[]), ...(large.run(query) as Hit[])].sort((a, b) => a.score - b.score);
      const reference = legacy.db
        .prepare(
          "SELECT m.id,bm25(messages_fts) score FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY score",
        )
        .all(terms.join(" "));
      expect(hits.map((x) => x.id)).toEqual(reference.map((x) => x.id));
      for (let i = 0; i < hits.length; i++) expect(hits[i].score).toBeCloseTo(Number(reference[i].score), 10);
    } finally {
      legacy.db.close();
      small.db.close();
      large.db.close();
    }
  });
  it("treats long search strings, underscore and percent as literals without the runtime LIKE pattern limit",()=>{
    const {db,run}=fixture();
    const query="correlation_"+("later.dog%".repeat(12))+"🦮";
    run({op:"messages.append",message:message("first","prefix "+query+" suffix")});
    run({op:"messages.append",message:message("second","other")});
    expect(run({op:"messages.search",query})).toMatchObject([{messageId:"first",matchLength:query.length}]);
    expect(run({op:"messages.search",query:query.replaceAll("%","_")})).toEqual([]);
    db.close();
  });
  it("finds both ends of an oversized Unicode message, verifies its exact raw JSON and can later make it small", () => {
    const { db, sql, run } = fixture();
    const body = "anchor " + "quoted 🐕 🦮 漢字 ".repeat(100000) + " finalneedle";
    const full = message("large", body, { requestPending: true, attachment: "héllo".repeat(200000) });
    run({ op: "messages.append", message: full });
    expect(run({ op: "messages.pending" })).toBe(true);
    expect(run({ op: "messages.search", query: " finalneedle", limit: 1 })).toMatchObject([
      { messageId: "large", snippet: expect.stringContaining("finalneedle") },
    ]);
    expect(run({ op: "messages.references", fragment: "héllohéllohéllo" })).toBe(true);
    expect(
      run({ op: "messages.recall", match: '"anchor" "finalneedle"', terms: ['"anchor"', '"finalneedle"'], limit: 5 }),
    ).toMatchObject([{ id: "large" }]);
    expect(run({ op: "messages.text", id: "large" })).toMatchObject({ text: body });
    expect(run({ op: "messages.page" })).toMatchObject({ messages: [full] });
    const rid = String(db.prepare("SELECT rowid FROM messages").get()!.rowid);
    expect(readHistoryValue(sql, "messages", rid, "json", "")).toBe(JSON.stringify(full));
    expect(db.prepare("SELECT max(length(bytes)) size FROM history_values").get()!.size).toBeLessThanOrEqual(
      384 * 1024,
    );
    const raw = ' { "payload":' + JSON.stringify("other".repeat(100000)) + " } ";
    const row = storeHistoryMessageValues(sql, ["15", "thread", "m", "5", "user", "text", null, raw]);
    expect(readHistoryValue(sql, "messages", "15", "json", String(row[7]))).toBe(raw);
    run({ op: "messages.update", message: message("large", "short") });
    expect(run({ op: "messages.search", query: "finalneedle" })).toEqual([]);
    expect(run({ op: "messages.recall", match: '"finalneedle"', terms: ['"finalneedle"'] })).toEqual([]);
    expect(db.prepare("SELECT count(*) n FROM history_values WHERE entry=?").get(rid)!.n).toBe(0);
    db.close();
  });
});

it("finds stale approval candidates and derives anchored windows and branch versions from the shard",()=>{
  const {db,run}=fixture();
  const rows=[
    {id:"first",at:1,role:"user",kind:"text",text:"one"},
    {id:"answer",at:2,role:"bot",kind:"text",text:"two"},
    {id:"earlier",at:3,role:"user",kind:"text",parentId:"answer"},
    {id:"active",at:4,role:"user",kind:"text",parentId:"answer"},
    {id:"prompt",at:5,role:"bot",kind:"options",card:{tool:"ask_bot",requestId:"id"}}
  ];
  try{
    run({op:"messages.import",messages:rows,leaf:"active"});
    expect(run({op:"messages.hasCards"})).toBe(true);
    const info=run({op:"messages.navigation",around:"active",limit:3}) as {versions:unknown;activeLeafId:string;firstAfter:string|null;hasMore:boolean;limit:number};
    expect(info).toMatchObject({activeLeafId:"active",limit:3,hasMore:true,firstAfter:null,versions:{earlier:{index:1,count:2,ids:["earlier","active"]},active:{index:2,count:2,ids:["earlier","active"]}}});
    const before=run({op:"messages.navigation",before:"earlier",limit:2}) as typeof info;
    const page=run({op:"messages.page",backward:true,normalize:true,limit:before.limit,after:before.firstAfter}) as {messages: {id:string;parentId:string|null}[]};
    expect(page.messages.map(m=>[m.id,m.parentId])).toEqual([["answer","first"],["first",null]]);
    expect(run({op:"messages.navigation",around:"absent",limit:1})).toBe(null);
    run({op:"messages.update",message:{...rows.at(-1),card:{answered:"deny"}}});
    expect(run({op:"messages.hasCards"})).toBe(false);
  }finally{db.close();}
});

it("preserves all startup flags on ordinary, spilled and earlier spilled rows",()=>{
  const {sql,db,run}=fixture();
  try{
    for(const [i,size] of [0,500000].entries()){
      const id="receipt-"+i,original={id,at:i,role:"bot",kind:"options",text:"x".repeat(size),needsYou:{status:"waiting"},card:{requestType:"permission",autoAnswerAt:123}};
      run({op:"messages.append",message:original});
      expect(run({op:"messages.startupFacts"})).toEqual({waiting:true,permission:true,countdown:true});
      if(size){sql.exec("UPDATE messages SET json=json_remove(json,'$.historyIndexVersion','$.needsYou') WHERE id=?",id);
        expect(run({op:"messages.startupFacts"})).toEqual({waiting:true,permission:true,countdown:true});}
      run({op:"messages.update",message:{...original,needsYou:{status:"complete"},card:{answered:"allow"}}});
      expect(run({op:"messages.startupFacts"})).toEqual({waiting:false,permission:false,countdown:false});
    }
  }finally{db.close();}
});
