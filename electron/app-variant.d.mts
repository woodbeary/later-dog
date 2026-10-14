export interface VariantPorts {
  readonly companion: number;
  readonly companionControl: number;
  readonly server: readonly number[];
  readonly webhookOffset: number;
  readonly companionRelay: readonly number[];
  readonly supervisor: number;
  readonly profiles: { readonly first: number; readonly last: number };
}
export interface VariantDefinition {
  readonly id: "release" | "dev";
  readonly productName: string;
  readonly appId: string;
  readonly scheme: string;
  readonly dataDirName: string;
  readonly userDataDirName: string;
  readonly logsDirName: string | null;
  readonly desktopEntry: string;
  readonly cuaHostBundleId: string;
  readonly tempPrefix: string;
  readonly iconPath: string;
  readonly ports: VariantPorts;
  readonly updates: { readonly channel: string | null; readonly feedFile: string; readonly cacheDirName: string; readonly releaseCheck: boolean };
}
export interface ScriptTarget {
  live?: boolean;
  refusal?: string;
  home?: string;
  serverPort?: number;
  supervisorPort?: number;
  uiPort?: number;
}
export const DEV: "dev";
export const RELEASE: "release";
export const LIVE_DATA_ENV: string;
export const LIVE_DATA_FLAG: string;
export const VARIANT_ENV: string;
export const VARIANT_FIELD: string;
export const VARIANT_IDS: readonly string[];
export const SCRIPT_DEFAULTS: { readonly dataDirName: string; readonly serverPort: number; readonly uiPort: number; readonly supervisorPort: number };
export const variant: VariantDefinition;
export function applyVariantEnvironment(definition: VariantDefinition, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function describeVariant(id: string): VariantDefinition;
export function resolveVariant(input?: object): VariantDefinition;
export function resolveVariantId(input?: object): "release" | "dev";
export function bundleIsDev(execPath: string): boolean;
export function dataDirFor(definition: VariantDefinition, options?: { env?: NodeJS.ProcessEnv; home?: string }): string;
export function profilesDataDirFor(definition: VariantDefinition, options?: { env?: NodeJS.ProcessEnv; home?: string }): string;
export function releaseDataDir(home?: string): string;
export function userDataDirFor(definition: VariantDefinition, appData: string): string;
export function logsDirFor(definition: VariantDefinition, options?: { home?: string; platform?: string; userData?: string }): string | null;
export function deepLink(definition: VariantDefinition, host: string): string;
export function deepLinkPattern(definition: VariantDefinition, hosts: readonly string[]): RegExp;
export function safeStorageService(definition: VariantDefinition): string;
export function tempName(definition: VariantDefinition, name: string): string;
export function serverPortRange(definition: VariantDefinition): string;
export function webhookPortFor(definition: VariantDefinition, serverPort: number): number;
export function ownedPorts(definition: VariantDefinition): Set<number>;
export function liveDataRequested(input?: { argv?: string[]; env?: NodeJS.ProcessEnv }): boolean;
export function scriptTarget(input?: { argv?: string[]; env?: NodeJS.ProcessEnv; home?: string }): ScriptTarget;
export function readPackageJson(directory?: string): Record<string, unknown> | null;
export function samePath(a: string, b: string): boolean;
export const APP_VARIANT_ENV: string;
export function companionDirFor(definition: VariantDefinition, options?: { env?: NodeJS.ProcessEnv; home?: string }): string | null;
export function insidePath(parent: string, child: string, options?: { caseInsensitive?: boolean }): boolean;
export function readBundleIdentifier(execPath: string, readFile?: (path: string, encoding: string) => string): string | null;
