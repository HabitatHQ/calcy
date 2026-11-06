# Calculator correctness and recovery

## Scope and integration

Integrate the pending lifecycle, settings restore, sample validation, binomial-mode and Markdown fixes with the existing review fixes. Work on `fix/all-findings` in its worktree, preserve the original checkout, and do not push.

## Contracts and implementation

1. **Parsing, display, editor and exports (1, 2, 4, 6, 11, 16 CSV, 17):** scaled currency denominations retain their numeric scale and label; numeric tokens never discard suffixes; explicit zero remains zero before number-word scales; powers bind before unary signs; pinning only rewrites the outer `in`, before `where` bindings; CSV quotes carriage returns. Repository tools exclude nested worktrees without ignoring the checkout containing them.
2. **Value evaluation (3 shared units, 7, 8, 9, 10):** preserve axis alignment and temperature differences through supported operations, reject unsupported collection shapes with domain errors, and reject non-finite scenario cells and distribution draws. Finite ranges have bounded cardinality and strictly progressing values. Signed parenthesized lower bounds remain supported.
3. **Engine declarations and numerical options (3 block parsing, 5, 12, 13, 15 engine/CLI):** preserve constructor/public declarations while resetting sheet directives between evaluations; current-sheet units remain visible to autocomplete. Unit and bridge scales are finite and positive. Distribution bounds are ordered, confidence lies in (0, 1), and calendar durations are positive finite days. Correlation blocks export singleton declarations, reject repeated pairs/assignment RHS, distinguish invalid targets from insufficient sample rank, and contain invalid members as per-line errors.
4. **Persistence and state (14, 15 UI, 16 async):** flush before exporting; validate SQLite integrity/schema/rows/custom-unit dependencies in a scratch copy before replacement; recover original bytes on write failure; keep recoverable in-memory data with a persistent visible warning if disk rollback also fails. Empty restores adopt a fresh sheet. JSON merges and unit mutations validate the effective dependency set before writing. The DB worker serializes requests across awaited imports. Calendar edits preserve the last valid value. Evaluation generations and autosave suspension protect document transitions. Unit validation never replaces the active inspector engine with a trial sheet.

## Regression coverage

- Existing engine, scenario, affine-difference, parser, natural-language, math-constants, editor, export, settings, binomial and CLI modules cover the affected behavior.
- `tests/audit-regressions.test.ts` adds numerical and lifecycle boundaries plus seeded property tests for currency round trips and monotonic distribution quantiles.
- `e2e/audit-regressions.spec.ts` covers real pinning and calendar controls, unit dependency failures, SQLite preflight and empty restore, atomic JSON rejection, stale real worker replies, pending-autosave deletion, custom-unit write failure and double-failure recovery. Storage failures are injected at the real browser filesystem boundary; SQLite and worker implementations remain real.
- Existing data, layout, multi-tab, SQLite export/import recovery and Tape-isolation browser modules remain green.

## Verified results

- 1,095 Vitest tests in 75 complete modules pass.
- 27 Chromium scenarios across seven complete browser modules pass in isolated contexts.
- Svelte/type checks, ESLint and Knip pass. Biome passes with two existing optional-chain warnings in `tests/correlate-block.test.ts`.
- Static production build passes.
- Actual CLI workbooks and live-browser visual smoke checks verify denomination labels, number words, exponent precedence, scenario cell arithmetic/temperature conversion, range rejection and invalid-confidence rejection.

Current-sheet declaration visibility is intentional, not leakage. Unsupported list arithmetic and scenario mixture/conditioning forms fail explicitly rather than manufacturing NaN values. A FIFO engine worker alone does not imply out-of-order delivery; the regression delays a real reply to exercise the UI's freshness boundary.
