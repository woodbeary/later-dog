# Item 33 fixture run, 15 November 2026: every step

Run on a Linux cloud computer with 4 cores, `main` `0651657`, the pinned browser engine 0.37.0 and Chromium on an X display at 1280x800:

```sh
node --experimental-strip-types scripts/browser-steps/measure.ts --engine <path to the pinned browser engine> --display :0 --chromium /usr/bin/chromium --out <new folder>
```

Text tokens are bytes / 4; image tokens are width x height / 750 for the size the engine is sent (1280x800 today, about 1,366). A scripted caller makes the calls; turn numbers are the model turns a careful model needs at least.

## find, structured

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | agent_browser_open | 1932 | 0 | 493 | 0.734 |
| 2 | agent_browser_read | 1733 | 0 | 434 | 0.032 |
| 3 | agent_browser_click | 514 | 0 | 134 | 0.049 |
| 4 | agent_browser_read | 419 | 0 | 106 | 0.049 |

## find, screen

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 40 | 0.012 |
| 2 | screenshot | 0 | 136468 | 1367 | 0.028 |
| 3 | scroll | 87 | 0 | 34 | 0.813 |
| 4 | screenshot | 0 | 136148 | 1367 | 0.030 |
| 5 | click | 87 | 0 | 26 | 0.110 |
| 6 | screenshot | 0 | 88592 | 1367 | 0.028 |

## form, structured

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | agent_browser_open | 1313 | 0 | 339 | 0.689 |
| 2 | agent_browser_fill | 513 | 0 | 139 | 0.027 |
| 2 | agent_browser_fill | 513 | 0 | 140 | 0.050 |
| 2 | agent_browser_fill | 513 | 0 | 138 | 0.028 |
| 2 | agent_browser_select | 534 | 0 | 144 | 0.027 |
| 2 | agent_browser_fill | 513 | 0 | 144 | 0.026 |
| 3 | agent_browser_click | 514 | 0 | 134 | 0.044 |
| 4 | agent_browser_read | 294 | 0 | 74 | 0.046 |

## form, screen

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 41 | 0.008 |
| 2 | screenshot | 0 | 85084 | 1367 | 0.027 |
| 3 | click | 87 | 0 | 26 | 0.108 |
| 4 | type_text | 87 | 0 | 28 | 0.139 |
| 5 | key_press | 87 | 0 | 25 | 0.022 |
| 6 | type_text | 87 | 0 | 29 | 0.140 |
| 7 | key_press | 87 | 0 | 25 | 0.021 |
| 8 | type_text | 87 | 0 | 27 | 0.139 |
| 9 | key_press | 87 | 0 | 25 | 0.020 |
| 10 | key_press | 87 | 0 | 25 | 0.021 |
| 11 | key_press | 87 | 0 | 25 | 0.021 |
| 12 | type_text | 87 | 0 | 33 | 0.139 |
| 13 | key_press | 87 | 0 | 25 | 0.021 |
| 14 | key_press | 87 | 0 | 26 | 0.021 |
| 15 | screenshot | 0 | 78008 | 1367 | 0.028 |

## table, structured

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | agent_browser_open | 898 | 0 | 235 | 0.704 |
| 2 | agent_browser_fill | 513 | 0 | 138 | 0.045 |
| 2 | agent_browser_fill | 513 | 0 | 140 | 0.027 |
| 3 | agent_browser_click | 514 | 0 | 134 | 0.026 |
| 4 | agent_browser_read | 768 | 0 | 193 | 0.073 |

## table, screen

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 40 | 0.009 |
| 2 | screenshot | 0 | 80260 | 1367 | 0.026 |
| 3 | click | 87 | 0 | 26 | 15.249 |
| 4 | type_text | 87 | 0 | 27 | 0.139 |
| 5 | key_press | 87 | 0 | 25 | 0.022 |
| 6 | type_text | 87 | 0 | 29 | 0.139 |
| 7 | key_press | 87 | 0 | 26 | 0.022 |
| 8 | screenshot | 0 | 143364 | 1367 | 0.028 |
