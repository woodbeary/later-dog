import { answerHook, hookBudget } from "./hook-answer.ts";

const MAX_INPUT_BYTES = 1024 * 1024;
const [argUrl, argTokenFile] = process.argv.slice(2);
const fromCommand = argUrl !== undefined && argTokenFile !== undefined;
const url = (fromCommand ? argUrl : process.env.LATERDOG_HOOK_URL) ?? "";
const tokenFile = (fromCommand ? argTokenFile : process.env.LATERDOG_HOOK_TOKEN_FILE) ?? "";
const requireReply = process.env.LATERDOG_REQUIRE_HOOK_REPLY === "1";
const budgetMs = hookBudget(process.env);

const unavailable = () => process.exit(requireReply ? 2 : 0);
process.stdout.on("error", () => process.exit(0));
const fuse = setTimeout(unavailable, budgetMs);
fuse.unref();

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT_BYTES) return unavailable();
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return unavailable();
  }
  const answer = await answerHook({ url, tokenFile, payload, budgetMs, requireReply });
  if (answer.code !== 0) return process.exit(answer.code);
  if (!answer.stdout) return process.exit(0);
  process.stdout.write(answer.stdout, () => process.exit(0));
}

void main();
