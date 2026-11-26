# Stored conversation folders: durability checks

Quiet conversation folders can move into the home's archive and return before the engine starts the next turn. The storage index is persisted and synced before local files are cleared. Parts have fixed names, byte sizes and SHA256digests; restore checks every part before extracting into a private scratch directory. Merge uses exclusive links, preserves current local files and links, and retains the recovery record until restored contents and directory metadata have been synced.

An interrupted restore keeps the pending turn. Generated storage-note recovery after later filesystem failures is best effort; a continuing filesystem fault can prevent the visible note from being restored. Power-loss atomicity and cross-process path replacement are not claimed.

The checked archive source is SHA256ed610491ccee5f81eae118bab9e7510e757797920e9aa77b60e78a83f51168c5. All66archive/pressure/isolated-server checks,17house checks, full typechecking and touched-file lint passed. A tiny real-object-store proof uploaded11,077bytes and downloaded21,290bytes: a fresh Node process restored exact file bytes, modes, links and empty directories, preserving current local contents. Only two fixture-created object keys were deleted afterward; no user folder or production release was changed for verification.

This source must be integrated with the separate backup portability guard and metadata-backed conversation provider repair before release. Exports must refuse unresolved archive pointers rather than silently omit stored work. Restoring large folders currently shows generic working activity and console-only storage status; there is no storage-specific progress UI. Remote archive parts remain retained indefinitely.

Complete clean integrated gate and live activation checks are required. These focused fixtures and object-store checks do not qualify a production deployment alone.
