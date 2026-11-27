import { parentPort } from "node:worker_threads";

import * as skills from "./skills.ts";
import { RECEIPT_FAILED, SKILL_OPS, type SkillCall, type SkillOp } from "./skills-thread.ts";

parentPort!.on("message", (call: SkillCall) => {
  try {
    if (!SKILL_OPS.includes(call.op as SkillOp)) throw new Error(`unknown skills call ${call.op}`);
    const args = [...call.args];
    if (call.receipt) {
      const answer = new Int32Array(call.receipt);
      const hook = (skill: unknown) => {
        parentPort!.postMessage({ id: call.id, applied: skill });
        Atomics.wait(answer, 0, 0);
        if (Atomics.load(answer, 0) !== 1) throw new Error(RECEIPT_FAILED);
      };
      if (call.op === "applySkillWriteWithReceipt") args[2] = hook;
      else args[2] = { ...(args[2] as object), onApplied: hook };
    }
    const result = (skills[call.op as SkillOp] as (...inner: unknown[]) => unknown)(...args);
    parentPort!.postMessage({ id: call.id, result });
  } catch (error) {
    parentPort!.postMessage({ id: call.id, error: error instanceof Error ? error.message : String(error) });
  }
});
