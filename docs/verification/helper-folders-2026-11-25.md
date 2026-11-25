# Helper working folders and guest conversations

A current owner-work conversation with Full access may choose any existing working folder when creating a helper. Other sources stay inside the creating conversation's canonical working folder. Guest sources use their private task folder; parent paths, sibling-prefix paths and links leading outside are refused with403. Null, empty and omitted folder choices keep the helper's own default folder.

The helper's default conversation preserves the guest opener before any greeting or work. The established global Full migration may update stored approval settings, but guest dispatch stays restricted and uses Ask. Guest-origin coordination to an owner Full recipient creates a guest-marked private task. An owner's existing flow for intentionally starting a fresh conversation is unchanged.

The isolated HTTP fixtures reproduced outside-folder acceptance from guest, limited-owner and shared-workspace sources, plus loss of guest restrictions after global migration. Canonical-path regressions failed first. After repair, all237 tests across13complete related files passed without skips, together with full typechecking and lint. A separate production-store check confirms atomic opener persistence,0600permissions and reload into a fresh store.

These are fixture and source checks. A complete clean integrated gate and release verification remain required; no live-provider or interface proof is inferred.
