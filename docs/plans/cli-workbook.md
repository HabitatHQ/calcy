# CLI: evaluate a workbook file

Add a command-line entry point that reads a whole text file as a calcy
workbook, evaluates it with the existing engine, and prints the results as a
table. Built on [`@stricli/core`](https://github.com/bloomberg/stricli).

## Why this shape

The engine (`src/lib/engine/index.ts`) is already framework-agnostic and
synchronous — `new Engine(opts).evalSheet(text): SheetResult` is the whole
contract. The browser `EngineClient`/worker wrapper is irrelevant to a Node
CLI. Pure result serializers already exist in `src/lib/sheet/export.ts`
(`toCsv`, `annotatedBody`); we reuse and extend them so CLI output stays in
lock-step with the in-app export.

`tsx` already runs standalone TS in this repo (`scripts/gen-reference.ts`), so
the CLI ships as TS run through `tsx` — no separate build step. Engine and
export modules are imported by **relative path** (matching `gen-reference.ts`):
the engine dir has no runtime `$lib` imports, and `export.ts`'s only `$lib`
import is `import type` (erased at runtime), so `tsx` resolves everything while
`svelte-check` still type-checks against the `$lib` alias.

## Output formats

`--format table|md|csv|json` (default: `table` on a TTY, `md` when piped):

- **table** — boxed terminal table via the [`table`](https://www.npmjs.com/package/table) lib.
- **md** — GFM pipe table via [`markdown-table`](https://www.npmjs.com/package/markdown-table).
- **csv** — reuses `toCsv` from `export.ts` (identical to the in-app export).
- **json** — the raw `SheetResult` (typed arrays coerced to plain arrays).

All tabular formats share one row model. Columns mirror the app export:
`line, name, expression, result, kind, note`. One row per `value`/`unitdef`
line; a failing line shows `kind=error` with the message in `note`.

## Files

- `src/lib/sheet/export.ts` — extract `RESULT_HEADER` + `resultRows(results):
  string[][]`; rewrite `toCsv` in terms of them (byte-identical output). Single
  source of truth for the row model.
- `src/cli/render.ts` — pure: `render(result, format)` + per-format helpers.
- `src/cli/command.ts` — stricli `buildCommand`/`buildApplication`; reads the
  file (`-` = stdin), builds `EngineOptions` from flags, calls `render`.
- `src/cli/index.ts` — bin shim: `#!/usr/bin/env -S tsx`, `run(app, argv, {process})`.
- `package.json` — `bin.calcy` + `scripts.cli` (`tsx src/cli/index.ts`).
- `knip.json` — add `src/cli/index.ts` as an entry so the CLI + its deps aren't
  flagged unused by the pre-push gate.

## Flags

`-f/--format`, `-o/--output <file>`, `-N/--samples`, `-s/--seed`,
`-c/--confidence`, `--number-format`. Engine defaults come from
`DEFAULT_OPTIONS`.

## Tests (`tests/cli-render.test.ts`, vitest)

- `resultRows`/`RESULT_HEADER`: value, unitdef, dist, rate, and error lines map
  to the right columns; blanks/comments omitted.
- `toCsv` output unchanged after the refactor (guard against drift).
- `render` md/csv/table/json each produce well-formed output for a small sheet.
- One integration test drives the stricli app via `run()` with a fake process +
  temp file, asserting stdout.
