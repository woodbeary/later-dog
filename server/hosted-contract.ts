export const HOSTED_CONTRACT_VERSION = 1;
export const HOSTED_CONTRACT_HEADER = "x-laterdog-hosted-contract-version";
export const HOSTED_CONTRACT_METADATA = Object.freeze({
  contractVersion: HOSTED_CONTRACT_VERSION,
  supportedContractVersions: Object.freeze([HOSTED_CONTRACT_VERSION]),
  legacyPolicy: "legacy-v1",
});
export const HOSTED_CONTRACT_MISMATCH = "HOSTED_CONTRACT_MISMATCH";
export const HOSTED_CONTRACT_ERROR = "Admin and workspace runtime versions are incompatible. Ask your administrator to update the deployment.";

export function hostedContractCompatible(version: unknown): boolean {
  return version === undefined ? HOSTED_CONTRACT_VERSION === 1 : version === HOSTED_CONTRACT_VERSION;
}
