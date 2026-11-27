const encoder = new TextEncoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MARK = /\[swarm ([^\]]+)\]/;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
}

function turnOf(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = textOf(message.content);
    if (!text.trim()) continue;
    const found = MARK.exec(text);
    if (!found) return { rounds: 0, params: null };
    const params = Object.fromEntries(found[1].trim().split(/\s+/).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
    const rounds = messages.slice(index + 1).filter((later) => later.role === "assistant").length;
    return { rounds, params };
  }
  return { rounds: 0, params: null };
}

function toolNamed(tools, name) {
  return (tools ?? []).find((tool) => tool.name === name || tool.name?.endsWith(`__${name}`))?.name;
}

export function plan(body) {
  const { rounds, params } = turnOf(body.messages ?? []);
  if (!params) return { think: 50, text: "ok" };
  const think = Number(params.think ?? 600);
  const id = params.id ?? "x";
  const use = (name, input) => {
    const tool = toolNamed(body.tools, name);
    if (!tool) return { think, text: `swarm ${id} missing tool ${name}` };
    return { think, tool, input, ...(rounds === 0 ? { lead: `Working on it, swarm ${id}.` } : {}) };
  };
  const done = { think, text: `swarm ${id} done after ${rounds} rounds.`, chunks: Number(params.chunks ?? 4) };
  switch (params.kind) {
    case "tools": {
      const n = Number(params.n ?? 4);
      if (rounds >= n) return done;
      return use("Bash", { command: `sleep ${Number(params.sleep ?? 1)}; ls -la /tmp | head -40; seq 1 ${Number(params.lines ?? 400)}`, description: `swarm step ${rounds + 1}` });
    }
    case "message":
      if (rounds === 0 && params.peer) return use("coordinate_bots", { bot_ids: [params.peer], message: `[swarm kind=quick id=${id}-peer think=${think}] note from a teammate`, reply: "none" });
      return done;
    case "fanout":
      if (rounds === 0 && params.peers) return use("coordinate_bots", { bot_ids: params.peers.split(","), message: `[swarm kind=quick id=${id}-peer think=${think}] quick question from a teammate`, reply: "result" });
      return done;
    case "search":
      if (rounds === 0) return use("session_search", { query: "swarm done rounds", bot: "all", limit: 25 });
      return done;
    case "memory":
      if (rounds === 0) return use("memory_update", { action: "append", text: `swarm fact ${id} ${"detail ".repeat(40)}` });
      if (rounds === 1) return use("session_search", { query: "swarm fact", scope: "memory", limit: 25 });
      if (rounds === 2) return use("memory_log", { text: `swarm ${id} wrote a fact` });
      return done;
    case "exec":
      if (rounds === 0) return use("Bash", { command: atob(params.b64 ?? ""), description: "swarm setup" });
      return { think, text: `swarm ${id} exec done.` };
    default:
      return done;
  }
}

function usageOf(body) {
  const size = JSON.stringify(body.system ?? "").length + JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length;
  return { input_tokens: Math.ceil(size / 4), output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function blocksOf(step) {
  if (!step.tool) return [{ type: "text", text: step.text }];
  const use = { type: "tool_use", id: `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`, name: step.tool, input: step.input };
  return step.lead ? [{ type: "text", text: step.lead }, use] : [use];
}

async function stream(writer, body, step) {
  const model = body.model ?? "stand-in";
  const usage = usageOf(body);
  const id = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  try {
    await writer.write(sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }));
    await sleep(step.think);
    const blocks = blocksOf(step);
    for (const [index, block] of blocks.entries()) {
      if (block.type === "tool_use") {
        await writer.write(sse("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } }));
        await writer.write(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }));
      } else {
        await writer.write(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
        const words = block.text.split(" ");
        const per = Math.ceil(words.length / Math.max(1, step.chunks ?? 1));
        for (let at = 0; at < words.length; at += per) {
          await writer.write(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: words.slice(at, at + per).join(" ") + (at + per < words.length ? " " : "") } }));
          if (at + per < words.length) await sleep(300);
        }
      }
      await writer.write(sse("content_block_stop", { type: "content_block_stop", index }));
    }
    const last = blocks.at(-1);
    await writer.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: last.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }));
    await writer.write(sse("message_stop", { type: "message_stop" }));
  } finally {
    await writer.close().catch(() => {});
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/v1/messages/count_tokens")) {
      const body = await request.json().catch(() => ({}));
      return Response.json({ input_tokens: usageOf(body).input_tokens });
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/v1/messages")) {
      return Response.json({ type: "error", error: { type: "not_found_error", message: "stand-in model" } }, { status: 404 });
    }
    const body = await request.json().catch(() => ({}));
    const step = plan(body);
    if (!body.stream) {
      await sleep(step.think);
      const blocks = blocksOf(step);
      return Response.json({ id: "msg_stand_in", type: "message", role: "assistant", model: body.model ?? "stand-in", content: blocks,
        stop_reason: blocks.at(-1).type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null, usage: usageOf(body) });
    }
    const { readable, writable } = new TransformStream();
    void stream(writable.getWriter(), body, step);
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  },
};
