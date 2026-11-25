# Composer controls at enlarged text

The action row now wraps within the composer. The model label and account details can shrink, while Send and the other action targets keep their size. The complete model name remains in its accessible label.

## Checked behavior

An isolated renderer fixture uses the real Composer and ModelPicker with short and long model/account labels. At 375 px with 200% content zoom, six baseline cases failed. After the CSS change all twelve cases pass in light and dark, at 1,100 px and 375 px, normal and enlarged content, with reduced motion.

For the short model at 375 px and 200% zoom, document width fell from 474 px to 375 px. Send fits inside the composer at x233..289 and clicking it clears the draft. Normal-size short-model viewport captures are byte-identical before and after.

Browser checks also cover non-overlapping reachable controls, preserved Send target size, opening the model picker, and the complete accessible model label. Typecheck and lint pass, as do 149 focused Composer, ModelPicker, brand and no-comments tests.

Evidence remains outside the repository in the Desktop Polish workspace under composer-bounds-inputs. The before/after viewports and original 3x composer crops were visually inspected. These measurements are Chromium on Linux renderer evidence. Native Mac rendering is unverified because screen access is not lent.

A full clean-candidate pnpm gate is required before merge.
