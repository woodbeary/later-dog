import program from "./work-folder-census.program.txt";
import { homePrefix } from "./state.ts";

export type FolderCensusRequest = { op: "roots" } | { op: "scan"; root: string } |
  { op: "piece"; root: string; path: string; index: number; hash: string };

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safeName = (name: string) => name.length > 0 && name !== "." && name !== ".." && !name.includes("\0") && !name.includes("/") && name.length <= 255;

export function censusRoot(root: string): boolean {
  if (typeof root !== "string") return false;
  const parts = root.split("/");
  if (parts.length === 1) return safeName(root) && !root.startsWith(".");
  return parts[0] === ".laterdog" && identifier.test(parts[2] ?? "") &&
    (parts[1] === "workspaces" && parts.length === 3 || parts[1] === "task-workspaces" && parts.length === 4 && identifier.test(parts[3]!));
}

export async function workFolderCensus(
  bucket: R2Bucket, stable: string, machineId: string, container: DurableObjectState["container"], nonce: string, request: FolderCensusRequest,
): Promise<ReadableStream> {
  if (!/^[a-f0-9]{64}$/.test(nonce) || !container?.running) throw new Error("Unavailable working folder census");
  const key = homePrefix(stable) + "work-folders/census-authorizations/" + nonce;
  const permit = await (await bucket.get(key))?.json<{machineId:string; expiresAt:number; roots:string[]}>();
  if (!permit || permit.machineId !== machineId || !Number.isSafeInteger(permit.expiresAt) || permit.expiresAt <= Date.now() ||
      permit.expiresAt > Date.now() + 24 * 60 * 60_000 || !Array.isArray(permit.roots)) throw new Error("No active working folder census");
  if (request.op !== "roots") {
    if (!censusRoot(request.root) || !permit.roots.includes(request.root)) throw new Error("Unassigned census root");
    if (request.op !== "scan" && (request.op !== "piece" || typeof request.path !== "string" || request.path.length > 4095 ||
        (request.path && !request.path.split("/").every(safeName)) || !Number.isSafeInteger(request.index) || request.index < 0 ||
        !/^[a-f0-9]{64}$/.test(request.hash))) throw new Error("Invalid census operation");
  }
  const child = await container.exec(["node", "--input-type=module", "--eval", program, JSON.stringify(request)], { user: "dog", stderr: "ignore" });
  if (!child.stdout) throw new Error("No working folder census stream");
  const source = child.stdout.getReader();
  return new ReadableStream({
    type: "bytes",
    async pull(controller) {
      const { value, done } = await source.read();
      if (!done) { controller.enqueue(value); return; }
      if (await child.exitCode !== 0) { controller.error(new Error("Working folder census ended before verification")); return; }
      controller.close();
    },
    async cancel() { child.kill(15); await source.cancel(); },
  });
}
