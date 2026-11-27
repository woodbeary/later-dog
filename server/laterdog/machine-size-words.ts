export const MACHINE_SIZES = ["small", "large"] as const;
export type MachineSize = (typeof MACHINE_SIZES)[number];

export const MACHINE_SIZE_HINT = "large for code, builds, tests and app work; small for errands, research, writing and messages. Omit to choose from the folder.";
