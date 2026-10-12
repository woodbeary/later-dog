import { isModelVariant, type EffortLevel, type ModelSelection } from "./contracts.ts";

export function assertModelVariantSupported(
  selection: Pick<ModelSelection, "variant" | "effort">,
  capabilities: { modelVariants?: boolean },
): void {
  if (selection.variant !== undefined &&
      (!isModelVariant(selection.variant) || !capabilities.modelVariants || selection.effort !== undefined)) {
    throw Object.assign(
      new Error("the saved model variant cannot be applied by this engine — choose a variant in model settings"),
      { status: 409, code: "unsupported_model_variant" },
    );
  }
}

export function memberTurnSelection(selection: ModelSelection): {
  model: string;
  effort?: EffortLevel;
  variant?: string;
  fast?: boolean;
} {
  return {
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
    ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
    ...(selection.fast ? { fast: true } : {}),
  };
}
