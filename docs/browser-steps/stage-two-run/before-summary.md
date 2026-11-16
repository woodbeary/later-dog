## Per task

| Task | Path | Tool calls | Model turns (min) | Tokens added | Image share | Tokens re-read over the task | Tool seconds (sum) | Seconds per call (mean) | Done right |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| find | screen | 6 | 7 | 4201 | 98% | 12731 | 1.01 | 0.17 | yes |
| form | screen | 15 | 16 | 3094 | 88% | 23509 | 0.88 | 0.06 | yes |
| table | screen | 8 | 9 | 2907 | 94% | 11786 | 15.64 | 1.95 | yes |

## Screenshot sizes

| Variant | JPEG bytes | Base64 in the tool result | Image tokens | Seconds |
| --- | ---: | ---: | ---: | ---: |
| today: 1280x800 JPEG q75 | 45597 | 60796 | 1366 | 0.031 |
| 1024x640 JPEG q60 | 21017 | 28024 | 874 | 0.040 |
| 794x496 JPEG q50 | 13903 | 18540 | 525 | 0.035 |

Screen tool definitions: 9145 bytes, the size at the stage-two head where this run was made; on main `0651657` they were 6,852 bytes (stage one, MEASURE.md).

## Per step

#### find, screen

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 40 | 0.012 |
| 2 | screenshot | 0 | 136980 | 1367 | 0.026 |
| 3 | scroll | 87 | 0 | 34 | 0.810 |
| 4 | screenshot | 0 | 136124 | 1367 | 0.027 |
| 5 | click | 87 | 0 | 26 | 0.108 |
| 6 | screenshot | 0 | 88816 | 1367 | 0.026 |

#### form, screen

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 41 | 0.011 |
| 2 | screenshot | 0 | 84940 | 1367 | 0.029 |
| 3 | click | 87 | 0 | 26 | 0.108 |
| 4 | type_text | 87 | 0 | 28 | 0.142 |
| 5 | key_press | 87 | 0 | 25 | 0.022 |
| 6 | type_text | 87 | 0 | 29 | 0.140 |
| 7 | key_press | 87 | 0 | 25 | 0.021 |
| 8 | type_text | 87 | 0 | 27 | 0.138 |
| 9 | key_press | 87 | 0 | 25 | 0.020 |
| 10 | key_press | 87 | 0 | 25 | 0.021 |
| 11 | key_press | 87 | 0 | 25 | 0.022 |
| 12 | type_text | 87 | 0 | 33 | 0.141 |
| 13 | key_press | 87 | 0 | 25 | 0.021 |
| 14 | key_press | 87 | 0 | 26 | 0.020 |
| 15 | screenshot | 0 | 78252 | 1367 | 0.028 |

#### table, screen

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 40 | 0.011 |
| 2 | screenshot | 0 | 80208 | 1367 | 0.027 |
| 3 | click | 87 | 0 | 26 | 15.253 |
| 4 | type_text | 87 | 0 | 27 | 0.139 |
| 5 | key_press | 87 | 0 | 25 | 0.021 |
| 6 | type_text | 87 | 0 | 29 | 0.138 |
| 7 | key_press | 87 | 0 | 26 | 0.020 |
| 8 | screenshot | 0 | 143544 | 1367 | 0.027 |
