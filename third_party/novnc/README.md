noVNC 1.6.0, the browser VNC client, copied unchanged from Debian's `novnc` package
(1:1.6.0-2, `core/` and `vendor/`) for the computers Worker's viewer page.

The Worker serves `public/` as static assets, so every file lives at a fixed, token-free, immutable URL:
`/novnc/1.6.0/core/rfb.js`. `public/_headers` sets the year-long cache. To change the version, add a new
`public/novnc/<version>/` folder, change `NOVNC_VERSION` in `deploy/laterdog/computers/src/novnc.ts`, and update the test
that reads the list of modules.

Licences: `COPYRIGHT.txt` lists each file's licence (MPL-2.0 for noVNC's own code, Expat for pako, Zlib and
BSD-2-clause for parts); `LICENSE-MPL-2.0.txt` is the MPL text. The notices in the source files stay as they came.
