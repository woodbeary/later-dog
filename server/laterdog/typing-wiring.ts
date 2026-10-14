import { smarterSuggestionsEnabled, typingSuggestionsEnabled, type AppConfig } from "../config.ts";
import { deciderReady, type Decider } from "../decider/index.ts";
import { createTypingSuggestionsRoutes } from "../routes/typing-suggestions.ts";
import type { RouteHandler } from "../routes/table.ts";
import { rankCandidates, TYPING_RANK_JOB } from "./typing-rank.ts";
import { createTypingService, describeTyping, includedCompletion } from "./typing-suggestions.ts";

export interface TypingWiring {
  routes: RouteHandler;
  describe(): ReturnType<typeof describeTyping>;
}

export function createTypingWiring(deps: { config(): AppConfig; decider: Pick<Decider, "choose">; fetch?: typeof fetch }): TypingWiring {
  const typing = createTypingService({ config: deps.config, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const rankingReady = () => typingSuggestionsEnabled(deps.config()) && smarterSuggestionsEnabled(deps.config()) && deciderReady(deps.config(), TYPING_RANK_JOB);
  return {
    routes: createTypingSuggestionsRoutes({
      typing,
      rankingReady,
      rank: (input, signal) => rankCandidates(deps.decider, input, signal),
    }),
    describe: () => describeTyping(deps.config(), includedCompletion(), rankingReady()),
  };
}
