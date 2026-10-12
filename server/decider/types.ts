
export type DeciderProvider = "jev";

export type DeciderJob = "roomRouting";
export const DECIDER_JOBS: readonly DeciderJob[] = ["roomRouting"];

export type DeciderSeam = DeciderJob | "keyCheck";

export type DeciderFailure =
  | "disabled"
  | "no_key"
  | "job_off"
  | "misconfigured"
  | "timeout"
  | "cancelled"
  | "unreachable"
  | "rejected"
  | "rate_limited"
  | "overloaded"
  | "http_error"
  | "malformed";

export interface ChoiceQuestion<K extends string = string> {
  type: "choice";
  instructions: string;
  options: Record<K, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  levels: string[];
}

export interface YesNoQuestion {
  type: "yesno";
  instructions: string;
  criteria?: { yes?: string; no?: string };
}

export type DeciderQuestion = ChoiceQuestion | ScoreQuestion | YesNoQuestion;

export interface ChoiceAnswer<K extends string = string> {
  type: "choice";
  choice: K;
  pTop: number;
  margin: number;
  probabilities: Partial<Record<K, number>>;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  level: number;
  probabilities: number[];
}

export interface YesNoAnswer {
  type: "yesno";
  p: number;
}

export type DeciderAnswer = ChoiceAnswer | ScoreAnswer | YesNoAnswer;

export type AnswerFor<Q> =
  Q extends ChoiceQuestion<infer K> ? ChoiceAnswer<K>
    : Q extends ScoreQuestion ? ScoreAnswer
      : YesNoAnswer;

export type Answers<Qs extends Record<string, DeciderQuestion>> = { [Id in keyof Qs]: AnswerFor<Qs[Id]> };

export type DeciderResult<T> =
  | { ok: true; provider: DeciderProvider; answers: T; latencyMs: number; inputTokens?: number; model?: string }
  | { ok: false; provider?: DeciderProvider; reason: DeciderFailure; status?: number; latencyMs?: number };

export interface AskOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BackendRequest {
  key: string;
  baseUrl?: string;
  state: unknown;
  questions: Record<string, DeciderQuestion>;
  signal: AbortSignal;
  fetch: typeof fetch;
}

export type BackendResult =
  | { ok: true; answers: Record<string, DeciderAnswer>; inputTokens?: number; model?: string }
  | { ok: false; reason: DeciderFailure; status?: number };

export interface DeciderBackend {
  id: DeciderProvider;
  decide(request: BackendRequest): Promise<BackendResult>;
}
