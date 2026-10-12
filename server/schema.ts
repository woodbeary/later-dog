import type { z } from "zod";

import type { JsonValue } from "../shared/json.ts";

export type { JsonObject, JsonPrimitive, JsonValue } from "../shared/json.ts";

export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

export function schemaIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const path = issue.path.map(String).join(".");
  return path ? `${path} ${issue.message}` : issue.message;
}
