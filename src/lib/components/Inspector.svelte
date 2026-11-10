<script lang="ts">
// Presentation-only: the right-hand inspector — selected-line actions, the
// rate/distribution/point detail for the current line, and the results grid.
import type { SheetController } from '$lib/state/sheet.svelte';
import DistributionPanel from './DistributionPanel.svelte';
import RateCard from './RateCard.svelte';
import ResultsGrid from './ResultsGrid.svelte';
import ResultText from './ResultText.svelte';
import Sensitivity from './Sensitivity.svelte';

let { c }: { c: SheetController } = $props();
const selectedLine = $derived(c.selectedLine);
</script>

<aside class="inspector">
	{#if selectedLine?.error}
		<!-- Show the plain-language hint first (matching the gutter and grid); the
		     precise developer message stays one hover away. -->
		<div class="err-box" role="alert" title={selectedLine.errorHint ? selectedLine.error : undefined}>
			⚠ {selectedLine.errorHint ?? selectedLine.error}
			{#if selectedLine.errorTopic}
				<button class="see-examples" onclick={() => c.openHelp(selectedLine.errorTopic)}>
					See examples: {selectedLine.errorTopic} →
				</button>
			{/if}
		</div>
	{/if}
	{#if selectedLine?.display && !selectedLine.error}
		<div class="result-actions">
			<button class="ra-btn" class:active={c.lineCopied} onclick={() => c.copyLine()} title="Copy this result">{c.lineCopied ? '✓ copied' : 'copy'}</button>
			<input
				class="pin"
				placeholder="convert to unit (e.g. mi)"
				bind:value={c.pinUnitInput}
				onkeydown={(e) => { if (e.key === 'Enter') c.pinLine(); }}
				aria-label="convert selected line to unit"
			/>
			<button class="ra-btn" onclick={() => c.pinLine()} disabled={!c.pinUnitInput.trim()}>pin</button>
		</div>
	{/if}
	{#if selectedLine?.isRate}
		<RateCard line={selectedLine} accumulate={c.accumulate} />
	{/if}
	{#if selectedLine?.isDist}
		<DistributionPanel line={selectedLine} fmt={c.numberFormat} />
		{#if c.engine}
			<Sensitivity engine={c.engine} index={c.selected} tick={c.evalTick} />
		{/if}
		<section class="sampling-note" aria-label="sampling details">
			<p>These draws are a reproducible estimate, not an exhaustive list of outcomes. A seed fixes the draws for this sheet and its current settings; it does not make an estimate exact.</p>
			<button class="doc-action" onclick={() => { c.closeOverlays(); c.openGuide(); }}>How to read this report</button>
			<button class="doc-action" onclick={() => c.toggleSettings()}>Sampling &amp; confidence settings</button>
		</section>
	{/if}
	{#if !selectedLine?.isRate && !selectedLine?.isDist && selectedLine?.display}
		<output class="point"><ResultText display={selectedLine.display} /></output>
	{/if}

	<div class="grid-section">
		<div class="grid-head">
			<h3>Sheet</h3>
			<div class="legend" aria-hidden="true">
				<span class="lg val">value</span>
				<span class="lg rate">rate</span>
				<span class="lg dist">distribution</span>
				<span class="lg err">error</span>
			</div>
		</div>
		<ResultsGrid lines={c.results} selected={c.selected} onselect={(i) => c.select(i)} blank={c.blank} />
	</div>
</aside>

<style>
	.inspector {
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.5rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-1);
	}
	.grid-section {
		flex: 1;
		min-height: 240px;
		display: flex;
		flex-direction: column;
	}
	.grid-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
		flex-wrap: wrap;
	}
	.grid-head h3 {
		margin: 0;
		color: var(--accent-soft);
		font-size: 0.85rem;
	}
	.legend {
		display: flex;
		gap: 0.6rem;
		font-size: 0.7rem;
	}
	.legend .lg {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--text-muted);
	}
	.legend .lg::before {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 2px;
		background: currentColor;
	}
	.legend .val {
		color: var(--c-value);
	}
	.legend .rate {
		color: var(--c-rate);
	}
	.legend .dist {
		color: var(--c-dist);
	}
	.legend .err {
		color: var(--c-error);
	}
	.point {
		display: block;
		font-family: var(--font-mono);
		font-size: 1.2rem;
		color: var(--c-value);
	}
	.result-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.result-actions .ra-btn {
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-2);
		border-radius: 6px;
		padding: 0.25rem 0.55rem;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.result-actions .ra-btn:hover:not(:disabled) {
		border-color: var(--color-brand);
	}
	.result-actions .ra-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.result-actions .ra-btn.active {
		border-color: var(--color-brand);
		color: var(--text);
	}
	.result-actions .pin {
		flex: 1;
		min-width: 0;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		color: var(--text);
		border-radius: 6px;
		padding: 0.25rem 0.45rem;
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}
	.err-box {
		color: var(--c-error);
		background: var(--danger-bg);
		border: 1px solid var(--danger-border);
		padding: 0.4rem 0.6rem;
		border-radius: 8px;
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}
	.see-examples {
		display: block;
		margin-top: 0.35rem;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: var(--accent-soft);
		font-family: inherit;
		font-size: 0.76rem;
		text-align: left;
	}
	.see-examples:hover {
		color: var(--color-brand);
		text-decoration: underline;
	}
	.sampling-note {
		border-top: 1px solid var(--border);
		padding-top: 0.45rem;
	}
	.sampling-note p {
		margin: 0 0 0.4rem;
		color: var(--text-faint);
		font-size: 0.72rem;
		line-height: 1.4;
	}
	.doc-action {
		display: inline-block;
		margin: 0.1rem 0.45rem 0.1rem 0;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent-soft);
		font: inherit;
		font-size: 0.74rem;
		cursor: pointer;
		text-align: left;
	}
	.doc-action:hover {
		color: var(--color-brand);
		text-decoration: underline;
	}
</style>
