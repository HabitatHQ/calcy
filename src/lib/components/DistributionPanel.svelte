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
</script>

{#if dist}
	<div class="dist">
		{#if line.display?.kind === 'dist'}
			<p class="plain">
				Most likely <strong>{withUnit(stat('median'))}</strong>—usually between
				<strong>{stat('p5')}</strong> and <strong>{withUnit(stat('p95'))}</strong>.
			</p>
		{:else}
			<!-- A distribution that collapsed to a single value (e.g. x − x): no
			     spread, so there's no "usually between" range to show. `text` already
			     carries the unit. -->
			<p class="plain">
				Always <strong>{line.display?.text}</strong>—no variation.
			</p>
		{/if}
		<Sparkline hist={dist.hist} width={280} height={64} />
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
