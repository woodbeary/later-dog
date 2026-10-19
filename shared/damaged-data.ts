export type DamagedDataName = "bots" | "groups" | "routines";

export interface DamagedData {
  name: DamagedDataName;
  keptAs: string | null;
}
