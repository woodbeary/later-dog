## Per task

| Task | Path | Tool calls | Model turns (min) | Tokens added | Image share | Tokens re-read over the task | Tool seconds (sum) | Seconds per call (mean) | Done right |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| find | page | 2 | 3 | 848 | 0% | 1494 | 1.06 | 0.53 | yes |
| find | page + run | 2 | 3 | 848 | 0% | 1494 | 1.05 | 0.52 | yes |
| find | screen capped | 6 | 7 | 2725 | 96% | 8303 | 1.08 | 0.18 | yes |
| find | screen capped + run | 4 | 5 | 2733 | 96% | 5511 | 1.89 | 0.47 | yes |
| form | page | 7 | 4 | 502 | 0% | 1064 | 3.59 | 0.51 | yes |
| form | page + run | 2 | 3 | 521 | 0% | 752 | 3.65 | 1.82 | yes |
| form | screen capped | 15 | 16 | 2110 | 83% | 16129 | 0.91 | 0.06 | yes |
| form | screen capped + run | 3 | 4 | 1957 | 89% | 2914 | 1.71 | 0.57 | yes |
| table | page | 4 | 4 | 554 | 0% | 954 | 2.06 | 0.51 | yes |
| table | page + run | 2 | 3 | 572 | 0% | 753 | 2.14 | 1.07 | yes |
| table | screen capped | 8 | 9 | 1923 | 91% | 7850 | 0.54 | 0.07 | yes |
| table | screen capped + run | 3 | 4 | 1876 | 93% | 2831 | 1.34 | 0.45 | yes |

Tool definitions: screen tools with the browser switch off 9145 bytes, on 11259 bytes; the eight page tools 2115 bytes; run_actions 1560 bytes.

## Per step

#### find, page

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | page_open | 2544 | 0 | 646 | 0.549 |
| 2 | page_click | 793 | 0 | 202 | 0.512 |

#### find, page + run

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | page_open | 2544 | 0 | 646 | 0.529 |
| 2 | page_click | 793 | 0 | 202 | 0.519 |

#### find, screen capped

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 40 | 0.009 |
| 2 | screenshot | 2 | 55776 | 875 | 0.045 |
| 3 | scroll | 87 | 0 | 34 | 0.824 |
| 4 | screenshot | 2 | 56860 | 875 | 0.044 |
| 5 | click | 87 | 0 | 26 | 0.120 |
| 6 | screenshot | 2 | 40964 | 875 | 0.042 |

#### find, screen capped + run

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 40 | 0.010 |
| 2 | screenshot | 2 | 52556 | 875 | 0.045 |
| 3 | run_actions | 57 | 53824 | 908 | 0.867 |
| 4 | run_actions | 69 | 40964 | 910 | 0.963 |

#### form, page

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | page_open | 884 | 0 | 231 | 0.537 |
| 2 | page_fill | 38 | 0 | 18 | 0.514 |
| 2 | page_fill | 38 | 0 | 20 | 0.506 |
| 2 | page_fill | 38 | 0 | 18 | 0.504 |
| 2 | page_fill | 38 | 0 | 24 | 0.501 |
| 2 | page_select | 48 | 0 | 20 | 0.492 |
| 3 | page_click | 668 | 0 | 171 | 0.535 |

#### form, page + run

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | page_open | 884 | 0 | 231 | 0.530 |
| 2 | run_actions | 808 | 0 | 290 | 3.119 |

#### form, screen capped

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 41 | 0.008 |
| 2 | screenshot | 2 | 41852 | 875 | 0.040 |
| 3 | click | 87 | 0 | 26 | 0.120 |
| 4 | type_text | 87 | 0 | 28 | 0.138 |
| 5 | key_press | 87 | 0 | 25 | 0.022 |
| 6 | type_text | 87 | 0 | 29 | 0.139 |
| 7 | key_press | 87 | 0 | 25 | 0.022 |
| 8 | type_text | 87 | 0 | 27 | 0.138 |
| 9 | key_press | 87 | 0 | 25 | 0.021 |
| 10 | key_press | 87 | 0 | 25 | 0.020 |
| 11 | key_press | 87 | 0 | 25 | 0.020 |
| 12 | type_text | 87 | 0 | 33 | 0.137 |
| 13 | key_press | 87 | 0 | 25 | 0.020 |
| 14 | key_press | 87 | 0 | 26 | 0.020 |
| 15 | screenshot | 2 | 38060 | 875 | 0.043 |

#### form, screen capped + run

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 41 | 0.007 |
| 2 | screenshot | 2 | 41852 | 875 | 0.041 |
| 3 | run_actions | 212 | 38060 | 1041 | 1.664 |

#### table, page

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | page_open | 684 | 0 | 181 | 0.518 |
| 2 | page_fill | 38 | 0 | 18 | 0.506 |
| 2 | page_fill | 38 | 0 | 20 | 0.511 |
| 3 | page_click | 1324 | 0 | 335 | 0.523 |

#### table, page + run

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | page_open | 684 | 0 | 181 | 0.524 |
| 2 | run_actions | 1398 | 0 | 391 | 1.616 |

#### table, screen capped

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 40 | 0.010 |
| 2 | screenshot | 2 | 39480 | 875 | 0.046 |
| 3 | click | 87 | 0 | 26 | 0.116 |
| 4 | type_text | 87 | 0 | 27 | 0.137 |
| 5 | key_press | 87 | 0 | 25 | 0.020 |
| 6 | type_text | 87 | 0 | 29 | 0.143 |
| 7 | key_press | 87 | 0 | 26 | 0.021 |
| 8 | screenshot | 2 | 57936 | 875 | 0.042 |

#### table, screen capped + run

| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | open_url | 121 | 0 | 40 | 0.011 |
| 2 | screenshot | 2 | 39480 | 875 | 0.046 |
| 3 | run_actions | 129 | 57936 | 961 | 1.283 |
