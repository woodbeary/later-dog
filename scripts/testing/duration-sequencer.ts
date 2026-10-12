import { readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export const SHARD_WEIGHTS_FILE = "scripts/testing/vitest-shard-weights.json";

const UNLISTED_SECONDS = 1;
const E2E = /\.e2e\.test\.[cm]?[jt]s$/;

export type ShardWeights = Readonly<Record<string, number>>;

export function loadShardWeights(root: string): ShardWeights {
  return JSON.parse(readFileSync(path.join(root, SHARD_WEIGHTS_FILE), "utf8")) as ShardWeights;
}

export function weightKey(root: string, moduleId: string, paths: typeof path = path): string | null {
  const relative = paths.relative(root, moduleId);
  if (!relative || paths.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${paths.sep}`)) return null;
  return relative.split(paths.sep).join("/");
}

function unlistedE2eSeconds(weights: ShardWeights): number {
  const e2e = Object.entries(weights).filter(([key]) => E2E.test(key)).map(([, seconds]) => seconds).sort((a, b) => a - b);
  if (e2e.length === 0) return UNLISTED_SECONDS;
  const middle = Math.floor(e2e.length / 2);
  return e2e.length % 2 ? e2e[middle] : (e2e[middle - 1] + e2e[middle]) / 2;
}

export function planShards(keys: readonly string[], weights: ShardWeights, count: number) {
  const e2eSeconds = unlistedE2eSeconds(weights);
  const seconds = keys.map((key) => Object.hasOwn(weights, key) ? weights[key] : E2E.test(key) ? e2eSeconds : UNLISTED_SECONDS);
  const order = keys.map((_, i) => i)
    .sort((a, b) => seconds[b] - seconds[a] || (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0));
  const loads = Array.from({ length: count }, () => 0);
  const shardOf: number[] = [];
  for (const i of order) {
    let target = 0;
    for (let shard = 1; shard < count; shard++) if (loads[shard] < loads[target]) target = shard;
    loads[target] += seconds[i];
    shardOf[i] = target;
  }
  return { shardOf, loads };
}

export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const weights = loadShardWeights(root);
    const keys = files.map((spec) => weightKey(root, spec.moduleId) ?? spec.moduleId);
    const { shardOf, loads } = planShards(keys, weights, shard.count);
    const mine = files.filter((_, i) => shardOf[i] === shard.index - 1);
    const listed = Object.keys(weights).length;
    const found = keys.filter((key) => Object.hasOwn(weights, key)).length;
    this.ctx.logger.log(
      `duration-sequencer: shard ${shard.index}/${shard.count} runs ${mine.length} of ${files.length} files, ` +
      `~${Math.round(loads[shard.index - 1])}s recorded; ${found} of ${listed} weighted files found`,
    );
    if (process.env.GITHUB_ACTIONS === "true" && found < listed * 0.9) {
      this.ctx.logger.log(
        `::warning title=duration-sequencer::Only ${found} of ${listed} weighted test files were found, so shards fall ` +
        `back to about equal file counts. Check ${SHARD_WEIGHTS_FILE} against the test file paths.`,
      );
    }
    return mine;
  }
}
