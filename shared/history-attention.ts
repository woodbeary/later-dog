import { readHistoryValue, type HistorySql } from "./history-values.ts";
export function historyAttentionTail(sql: HistorySql, thread: string) {
  type Row = {
    rid: string;
    role: string;
    id: string;
    at: number;
    kind: string;
    card: string | null;
    need: string | null;
    sender: string | null;
    peer: number;
    spilled: number;
  };
  const rows = sql.exec<Row>(
    `SELECT CAST(m.rowid AS TEXT) rid,id,role,at,kind,json_extract(json,'$.card') card,json_extract(json,'$.needsYou') need,json_extract(json,'$.from.botId') sender,json_type(json,'$.peerAsk') IS NOT NULL AND json_type(json,'$.peerAsk')!='null' peer,EXISTS(SELECT 1 FROM history_values h WHERE h.relation='messages' AND h.entry=CAST(m.rowid AS TEXT) AND h.field='json' AND h.part=0) spilled FROM messages m WHERE thread_id=? ORDER BY m.rowid DESC LIMIT 60`,
    thread,
  );
  const result = [];
  let person = false;
  for (const r of rows) {
    let card = r.card ? JSON.parse(r.card) : undefined,
      need = r.need ? JSON.parse(r.need) : undefined,
      sender = r.sender,
      peer = !!r.peer;
    if (r.spilled) {
      const m = JSON.parse(readHistoryValue(sql, "messages", r.rid, "json", ""));
      card = m.card;
      need = m.needsYou;
      sender = m.from?.botId;
      peer = !!m.peerAsk;
    }
    const human = r.role === "user" && !sender && !peer;
    if (!card && !need && (!human || person)) continue;
    person ||= human;
    result.push({
      id: r.id,
      at: r.at,
      role: r.role,
      kind: r.kind,
      ...(sender ? { from: { botId: sender } } : {}),
      ...(peer ? { peerAsk: true } : {}),
      ...(need ? { needsYou: { status: need.status, label: need.label } } : {}),
      ...(card
        ? {
            card: {
              requestId: card.requestId,
              answered: card.answered,
              dismissed: card.dismissed,
              expired: card.expired,
              title: card.title,
              subtitle: card.subtitle,
              deviceApproval: card.deviceApproval && {
                status: card.deviceApproval.status,
                renew: card.deviceApproval.renew,
                endedBy: card.deviceApproval.endedBy,
                service: card.deviceApproval.service,
              },
            },
          }
        : {}),
    });
  }
  return result.reverse();
}
