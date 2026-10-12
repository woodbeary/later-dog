export {
  acquireDataDirLease,
  acquireDataDirLeaseForProcess,
  DataDirLeaseError,
} from "../electron/data-dir-lease.mjs";

export type {
  DataDirLease,
  DelegatedDataDirLease,
  OwnedDataDirLease,
} from "../electron/data-dir-lease.mjs";
