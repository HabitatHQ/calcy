# Make existing modelling behaviours discoverable

## Scope

Improve the existing Help, Examples, Guide, and selected-line inspector. No new probabilistic modelling, enumeration, attribution, or inference engine; no evaluation semantics change.

- Add goal-oriented help and links to worked examples and the Guide.
- Add editable sheets named **Uncertainty drivers**, **Scenario comparison**, and **Condition on evidence** using the existing template model and safe new-sheet action.
- Structure uncertain-line detail as an uncertainty report: selected result, distribution statistics, sensitivity ranking, and sampling context with Guide/Settings actions.
- Describe sensitivity as squared Pearson correlation with named sampled variables—not additive or causal contributions. Include derived variables, the 1% threshold, and missing-score limitations.
- Explain labelled scenarios versus probability-weighted enumeration, filtering with `given` versus changing assumptions, and reproducibility versus accuracy.
- Correct median wording in the distribution summary; a median is not necessarily a most-likely value.

## Files and ownership

- Discovery: `src/lib/components/HelpPanel.svelte`, `TemplatesPanel.svelte`, and `src/routes/+page.svelte`.
- Examples and learning: `src/lib/templates.ts`, `src/lib/docs/guide.md`, `reference.md`.
- Interpretation: `src/lib/components/Inspector.svelte`, `Sensitivity.svelte`, `DistributionPanel.svelte`.
- Overview: existing `README.md` UI documentation.

## Invariants and risks

- Preserve the dirty primary checkout; work only in `.worktrees/feat-model-discovery`, based on current `origin/main`.
- Opening examples from a nonblank sheet must retain its source and create a different sheet using `newFromTemplate`.
- Scenario labels do not imply probabilities. Sampling weighted discrete alternatives is not exhaustive enumeration.
- Sensitivity correlates every eligible named sampled variable with the selected result; it does not establish dependency or causality. Overlapping scores need not total 100%; low scores can miss nonlinear relationships.
- Conditioning filters and resamples the requested result; it does not update the original variables or preserve a jointly conditioned sheet.
- A fixed seed reproduces draws only with the same source and engine/settings. It does not prove accuracy. Re-rolling changes the seed, not assumptions.
- Keep scalar views uncluttered, empty sensitivity honest, and controls usable on narrow screens and by keyboard.
- Do not modify tests or verification assets to make checks pass.

## Acceptance and verification

1. Evaluate all new template source with the real Engine. Require no errors; verify a duration sum and sensitivity ordering, labelled scenario results, and a conditioned duration whose maximum stays below the condition and mean decreases.
2. Browser smoke through Help → worked examples → each sheet; select uncertain results in the Sheet grid and observe the report. Follow Guide and Settings actions, verify the prior sheet survives, and inspect desktop/mobile rendering and keyboard activation.
3. Run existing targeted template/sensitivity/conditioning/scenario tests, then `pnpm lint`, `pnpm lint:svelte`, `pnpm check`, `pnpm knip`, `pnpm test`, and `pnpm build`.
4. After reviewer-agent review and correction of findings, commit and integrate into `origin/main` using a normal fast-forward push. Leave the dirty primary checkout and its local `main` untouched.
5. Review corrections: give Guide links explicit heading targets; distinguish pending/excluded sensitivity scores from negative findings; clarify that `[p5, p95]` applies to the default 90% interval.
