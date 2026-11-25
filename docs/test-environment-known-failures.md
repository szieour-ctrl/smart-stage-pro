# Known test-environment failures (not B1 regressions)

Nov 7, 2026. In a fresh checkout **without installed dependencies** (`node_modules` absent; the repository commits no lockfile), five test
files fail at load time with `MODULE_NOT_FOUND`. They are unrelated to B1 / Stage B and are not regressions.

| Test file | Missing module (first one hit) |
|---|---|
| `tests/agent-marketing-images.test.js` | `@aws-sdk/client-s3` |
| `tests/agent-marketing-media.test.js` | `@aws-sdk/client-s3` |
| `tests/agent-marketing-report-endpoint.test.js` | `pdfkit` |
| `tests/agent-marketing-report-read.test.js` | `write-excel-file/node` |
| `tests/agent-marketing-report-trends.test.js` | `pdfkit` |

**Verified:** after `npm install --no-save --ignore-scripts` all five pass (20 + 5 + 12 + 6 + 15 = 58 tests, 0 failures), and the whole
suite passes: **719 / 719** with `B1_WORKSPACE` set to the private workspace and `B1_FIXTURES_REQUIRED=1` (673 pass, 46 skipped without it).

**Rule for B1 work:** run `npm install` before `npm test`. A failure in any of these five files that is `MODULE_NOT_FOUND` is environmental;
any other failure in them, or any failure elsewhere, must be investigated as a real regression.
