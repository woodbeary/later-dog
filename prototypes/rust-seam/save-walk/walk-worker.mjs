import { parentPort, workerData } from "node:worker_threads";
import { scanSync } from "./walk-variants.mjs";

parentPort.postMessage(scanSync(workerData.root));
