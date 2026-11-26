export function stagePortableHistory(
  api: unknown,
  job: string,
  prepared: string,
  identity: { jobId: string; generation: string; expectedRevision: number },
): Promise<{ proofs: [string, string][]; catalog: string }>;
