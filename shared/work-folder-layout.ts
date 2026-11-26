import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const absoluteDirectory = z.string().refine(path => path.startsWith("/") && path !== "/" &&
  !path.includes("\0") && path.slice(1).split("/").every(part => part && part !== "." && part !== ".."));

export const workFolderLayoutSchema = z.object({
  dogs: z.array(identifier),
  tasks: z.record(identifier, z.array(identifier)),
  loose: z.object({
    owner: identifier,
    members: z.array(identifier),
    names: z.array(z.string().min(1).refine(name => !name.startsWith(".") && !name.includes("/") && !name.includes("\0"))),
  }).strict().optional(),
  projects: z.array(z.object({ path: absoluteDirectory, owner: identifier, members: z.array(identifier) }).strict()),
}).strict();

export const workFolderPlacementSchema = z.object({
  v: z.literal(1),
  mode: z.enum(["folders", "legacy"]),
  previous: z.string().nullable(),
  baselineManifest: checksum,
  verification: checksum,
  layout: workFolderLayoutSchema,
}).strict();

export type WorkFolderLayout = z.infer<typeof workFolderLayoutSchema>;
export type WorkFolderPlacement = z.infer<typeof workFolderPlacementSchema>;
