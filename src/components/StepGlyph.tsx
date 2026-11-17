import { Cloud, File, LoaderCircle, Monitor, PawPrint, Pencil, Play, Search } from "lucide-react";
import type { StepGlyphKind } from "@/lib/work-panel-model";

const ICONS = { play: Play, pencil: Pencil, page: File, magnifier: Search, screen: Monitor, paw: PawPrint, cloud: Cloud } as const;

export function StepGlyph({ kind }: { kind: StepGlyphKind }) {
  if (kind === "spinner") return <LoaderCircle data-glyph="spinner" size={14} strokeWidth={2} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;
  const Icon = ICONS[kind];
  return <Icon data-glyph={kind} size={16} strokeWidth={1.8} aria-hidden="true" />;
}
