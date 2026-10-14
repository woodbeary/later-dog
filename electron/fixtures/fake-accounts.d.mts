export interface FakeAccounts {
  origin: string;
  goodCode: string;
  otp: string;
  homeState: string;
  setup: { step: string; slow?: true } | undefined;
  failSend: { status: number; body: unknown } | null;
  failVerify: { status: number; body: unknown } | null;
  requests: Array<{ method: string | undefined; route: string | undefined; authorization: string | undefined; body: Record<string, unknown> }>;
  sent: string[];
  signedOut: string[];
  sessions: Map<string, string>;
  tokens: Map<string, string>;
  authorizations: Map<string, { userCode: string; status: string; deviceName?: string; email?: string }>;
  pairings: number;
  close(): Promise<void>;
}
export declare function startFakeAccounts(options?: { homeOrigin?: string; now?: () => number }): Promise<FakeAccounts>;
