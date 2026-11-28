import { parentPort } from "node:worker_threads";
import { skillsSystemPrompt } from "./skills.ts";

parentPort!.on("message", (request: { id: number; botId: string; assigned?: string[] }) => {
  try {
    parentPort!.postMessage({ id: request.id, text: skillsSystemPrompt(request.botId, request.assigned) });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, failed: error instanceof Error ? error.message : String(error) });
  }
});
