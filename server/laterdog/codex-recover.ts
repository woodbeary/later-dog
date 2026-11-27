import { engineComputer } from "../computers.ts";
import { CODEX_UUID } from "./codex-rollout.ts";

type Box = { exec(command: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string }>; read(path: string): Promise<Uint8Array> };

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export async function recoverCodexRolloutFrom(box: Box, launchRoot: string, cursor: string): Promise<{ name: string; bytes: Buffer } | null> {
  if (!CODEX_UUID.test(cursor)) return null;
  const found = await box.exec(`find ${quote(launchRoot)} -maxdepth 7 -type f -name ${quote(`rollout-*-${cursor}.jsonl`)} 2>/dev/null | head -3`, 60_000);
  const paths = found.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (paths.length !== 1) return null;
  const name = paths[0]!.split("/").slice(-4).join("/");
  return { name, bytes: Buffer.from(await box.read(paths[0]!)) };
}

export async function recoverCodexRollout(botId: string, launchRoot: string, cursor: string): Promise<{ name: string; bytes: Buffer } | null> {
  const { box } = await engineComputer(botId);
  return recoverCodexRolloutFrom(box, launchRoot, cursor);
}
