# calcy — agent notes

A SvelteKit + Vite single-page app (uncertainty-aware unit calculator). Pure
client-side SPA (`ssr = false`, prerendered shell), built to static files with
`@sveltejs/adapter-static`.

## Build & test

```sh
pnpm dev          # local dev server
pnpm build        # static build → build/
pnpm test         # vitest (unit / property / golden)
pnpm lint         # biome
pnpm check        # svelte-check (types)
pnpm cli <file>   # evaluate a workbook file from the terminal (src/cli/, tsx)
```

The CLI (`src/cli/`) is a thin Node front-end over the same `Engine`, run via
`tsx` — a second consumer of the framework-agnostic engine alongside the SPA.
It imports engine/export modules by relative path (not the `$lib` alias) so
`tsx` resolves them without Vite.

Run the full suite and lint/check before committing; only commit when green.

## CI / Publishing (GitHub Actions)

Two workflows run in `.github/workflows/`:

- **`ci.yml`** — on every push to `main` and every PR, runs the same gate as the
  local pre-push hook: `lint`, `lint:svelte`, `check`, `knip`, `test`.
- **`deploy.yml`** — on push to `main`, builds the static site and deploys
  `build/` to the `gh-pages` branch (via `JamesIves/github-pages-deploy-action`),
  adding `.nojekyll` so GitHub Pages serves the `_app/` directory.

GitHub Pages is configured to serve the **`gh-pages` branch, root**. The app uses
relative asset paths (`paths: { relative: true }`) and a `404.html` SPA fallback,
so it works at the project subpath (`/calcy/`) with no base-path config — and
local dev still works at `/`.

Deployment is automatic on push to `main`; `deploy.yml` can also be triggered
manually from the Actions tab (`workflow_dispatch`).

## Conventions

- Author identity for this project: **npalladium** / **Nikhil Reddy**.
- Use Unicode em dashes (`—`), no surrounding spaces; no trailing whitespace.
- TDD with small, individually-tested, atomic commits (see git history style).
