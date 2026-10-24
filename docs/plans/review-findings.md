# Review findings — finalized plan

This change resolves the thirteen reviewed behavior defects while preserving the existing engine, worker, persistence, and rendering boundaries.

1. **Ranges:** Generate list members from a computed finite cardinality, cap output at 1,000,000 entries, and reject non-finite inputs or non-progressing steps. A finite singleton at a large magnitude remains valid.
2. **Scenario functions:** Map ordinary unary/reducer and supported multi-argument calls over aligned/broadcast/crossed scenario cells. Sample reducers operate inside each cell; explicit `over` and selector operations remain axis-specific.
3. **Scenario sums:** Fold axis-bearing operands with the same axis resolver as arithmetic, retaining coordinate labels and checking dimensions.
4. **Scenario table units:** Parenthesize each cell expression before applying the table's shared trailing unit.
5. **Numeric literals:** Validate complete decimal/exponent syntax before numeric conversion; keep underscore separators and existing suffix/radix handling.
6. **Custom units:** Reject zero and non-finite scales at `defineUnit`, covering constructor and sheet declarations through the shared definition method. Negative finite scales remain accepted to avoid changing existing conventions.
7. **Call arity:** Reject multiple arguments to unary math/reducer calls while leaving explicit optional/variadic APIs unchanged.
8. **Scenario formatting:** Preserve one-axis wording and label multi-axis fallback entries with every axis coordinate.
9. **Closed-form identity:** Preserve exact correlation when operands reference the same sample array, including small sample counts, while retaining the independent-sample noise threshold.
10. **Tape isolation:** Give Tape a separately owned engine worker, dispose it with the component, and propagate seed, sample count, number format, calendar, confidence, and custom-unit settings.
11. **SQLite export:** Flush title/body/seed through the existing save path before reading export bytes. If that write fails, surface an error and do not create the export.
12. **SQLite import recovery:** Preserve the existing database bytes before replacement, validate integrity and required tables after import, restore on failure, reopen, and surface a UI error so subsequent reads/writes remain available. Verification uses an isolated browser context only; no real user storage is touched.
13. **CLI Markdown:** Encode literal ampersands, angle brackets, backslashes, backticks, and table pipes in rendered cells so code/formatting syntax cannot alter text or columns.

## Verification

- `pnpm test`: all 991 tests pass, including the full affected modules.
- `pnpm lint`, `pnpm lint:svelte`, `pnpm check`, `pnpm knip`, and `pnpm build` pass.
  Biome retains two existing optional-chain warnings in `tests/correlate-block.test.ts`.
- The data, layout, multi-tab, SQLite export/import recovery, and Tape isolation
  Playwright modules pass all 17 scenarios in isolated browser contexts.
- CLI workbook smoke checks exercise range termination, cellwise reducers,
  scenario sums and units, malformed literals, invalid units, arity validation,
  labelled multi-axis output, small-sample cancellation, and literal Markdown.
- Browser smoke checks confirm labelled scenario output and correct Notepad rate
  accumulation after evaluating Tape and switching back.
