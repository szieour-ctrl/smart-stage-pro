# SSP test baseline (Nov 5, 2026)

## Result

The suite is green on both commits when dependencies are installed where Node normally resolves them:

| Commit | What | Tests | Pass | Fail |
|---|---|---|---|---|
| `622f96e` | before the B1 integration (main, PR #217) | 627 | 627 | 0 |
| `4126e20` | B1 evidence integration | 638 | 638 | 0 |

Same machine, Node v22.23.4, npm 10.9.9, one shared dependency install, empty `AGENT_MARKETING_*` environment. Two
`could not read a pdf` log lines in each run come from the suite's own unreadable-file tests and are expected.

## The 11 "PDF upload" failures were a test-harness artifact

They were **not** pre-existing failures, **not** B1 regressions and **not** application defects. They came from how I ran the suite: with
dependencies installed outside the repo and made visible through `NODE_PATH`.

The cause: `agent-marketing-report-read-lib.js` loads `unpdf` and `pdfjs-dist` with a dynamic `import()`, which uses Node's ES-module resolver.
That resolver ignores `NODE_PATH`; only CommonJS `require()` honours it. So the import threw `ERR_MODULE_NOT_FOUND: Cannot find package 'unpdf'`.
The code's own error handling turned that into the user-facing "I couldn't open that file", so every test that uploads a PDF failed:
- the report-read tests;
- the report-endpoint tests;
- the trend-report tests.

The proof:
- With the same install linked as `node_modules` inside the checkout, both commits pass in full. With `NODE_PATH` only, both fail the same 11
  tests with the same log line: `[agent-marketing-report] could not read a pdf: Cannot find package 'unpdf' imported from …`.
- Earlier I called this "likely dependency-version drift". That was wrong.

The PDF code was not modified.

## To reproduce the baseline

```
npm install          # in the repository root; node_modules must sit in or above the checkout
npm test
```

Do not rely on `NODE_PATH` for this suite. Dependency versions the baseline was taken with (the repository has **no lockfile**, so a fresh
install can resolve newer versions):

```
@aws-sdk/client-s3@3.1162.0  @aws-sdk/s3-request-presigner@3.1162.0  @netlify/blobs@10.7.13  archiver@8.0.0  cloudinary@2.11.0
heic-convert@2.1.0  pdfjs-dist@4.10.38  pdfkit@0.15.2  qrcode@1.5.4  read-excel-file@9.3.14  sharp@0.34.5  unpdf@1.9.1  write-excel-file@4.1.1
```

Recommendation, not done here: commit a `package-lock.json` so the baseline is reproducible. `node_modules` is also not in `.gitignore`.
