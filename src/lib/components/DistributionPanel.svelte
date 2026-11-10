<script lang="ts">
import type { LineResult, NumberFormat } from '$lib/engine';
import Sparkline from './Sparkline.svelte';

// fmt is kept in the prop list for API compatibility; the figures are already
// formatted (and scaled into the display unit) by the engine in line.display.
let { line, fmt: _fmt = 'auto' }: { line: LineResult; fmt?: NumberFormat } = $props();

const dist = $derived(line.summary?.kind === 'dist' ? line.summary : null);
const unit = $derived(line.display?.unit ?? '');
const withUnit = (v?: string) => `${v ?? ''}${unit ? ` ${unit}` : ''}`;

// Pre-formatted, display-unit stats from the engine (mean, std dev, …, median, …).
const stats = $derived(line.display?.stats ?? []);
const stat = (label: string) => stats.find((s) => s.label === label)?.value;

// The active confidence band, shown as a natural frequency ("9 times in 10")
// rather than a percentile — frequencies are easier to reason about, and the
// band tracks the sheet's confidence level.
const level = $derived(line.display?.level ?? 0.9);
const pct = $derived(Math.round(level * 100));
function frequency(l: number): string {
	const n10 = l * 10;
	if (Math.abs(n10 - Math.round(n10)) < 1e-9) return `${Math.round(n10)} times in 10`;
	return `${Math.round(l * 100)} times in 100`;
}
</script>

{#if dist}
	<div class="dist">
		{#if line.display?.kind === 'dist'}
			<p class="plain">
				Median <strong>{withUnit(stat('median'))}</strong>—about
				<strong>{frequency(level)}</strong> of draws land between
				<strong>{line.display?.ciLow}</strong> and
				<strong>{withUnit(line.display?.ciHigh)}</strong>.
				<span class="lvl" title="'a to b' means a {pct}% confidence interval">{pct}% CI</span>
			</p>
		{:else}
			<!-- A distribution that collapsed to a single value (e.g. x − x): no
			     spread, so there's no "usually between" range to show. `text` already
			     carries the unit. -->
			<p class="plain">
				Always <strong>{line.display?.text}</strong>—no variation.
			</p>
		{/if}
		<!-- Skip the histogram when there's no spread: a degenerate distribution is
		     a single full-height bar that reads as a glitch rather than a shape. -->
		{#if dist.min !== dist.max}
			<Sparkline hist={dist.hist} width={280} height={64} />
		{/if}
		<details>
			<summary>All statistics</summary>
			<table>
				<tbody>
					{#each stats as { label, value } (label)}
						<tr class:hl={label === 'median'}>
							<th>{label}</th>
							<td>{withUnit(value)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</details>
	</div>
{:else}
	<p class="muted">Select a distribution-valued line to see its full stats.</p>
{/if}

<style>
	.dist {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.plain {
		margin: 0;
		font-family:
			system-ui,
			sans-serif;
		font-size: 0.9rem;
		line-height: 1.4;
		color: var(--text-2);
	}
	.plain strong {
		color: var(--text);
		font-weight: 600;
	}
	.lvl {
		display: inline-block;
		margin-left: 0.3rem;
		padding: 0 0.35rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--text-muted);
		vertical-align: middle;
		cursor: help;
	}
	details > summary {
		cursor: pointer;
		color: var(--text-muted);
		font-size: 0.74rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 0.35rem;
	}
	details > summary:hover {
		color: var(--text-2);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}
	th {
		text-align: left;
		color: var(--text-muted);
		font-weight: 400;
		padding: 0.2rem 0.5rem 0.2rem 0;
	}
	td {
		text-align: right;
		padding: 0.2rem 0;
		color: var(--text-2);
	}
	tr.hl th,
	tr.hl td {
		color: var(--c-dist);
		font-weight: 600;
	}
	tr:not(:last-child) th,
	tr:not(:last-child) td {
		border-bottom: 1px solid var(--surface-2);
	}
	.muted {
		color: var(--text-muted);
		font-size: 0.85rem;
		padding: 0.5rem;
	}
</style>
