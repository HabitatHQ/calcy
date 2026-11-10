<script lang="ts">
import type { SensitivityEntry } from '$lib/engine';
import type { EngineClient } from '$lib/engine/client';

// Scores are squared Pearson correlations with named sampled variables.
// They rank association; they are not additive variance contributions.
let {
	engine,
	index,
	tick
}: { engine: EngineClient; index: number; tick: number } = $props();

let entries = $state<SensitivityEntry[] | null>(null);

$effect(() => {
	void index;
	void tick; // re-fetch after each re-eval (seed/sample changes)
	let active = true;
	entries = null;
	engine.sensitivity(index).then((e) => {
		if (active) entries = e ?? [];
	});
	return () => {
		active = false;
	};
});
</script>

{#if entries === null}
	<div class="sens" role="status">
		<h3>Sensitivity</h3>
		<p class="note">Loading sensitivity scores…</p>
	</div>
{:else if entries.length}
	<div class="sens">
		<h3>Sensitivity</h3>
		<p class="note">Association with named sampled variables (r²), sorted highest first. Scores can overlap, include derived variables, and are not additive or causal contributions.</p>
		<ul>
			{#each entries as e (e.name)}
				<li>
					<span class="name">{e.name}</span>
					<span
						class="bar"
						role="meter"
						aria-label="{e.name} squared correlation"
						aria-valuenow={Math.round(e.r2 * 100)}
						aria-valuemin={0}
						aria-valuemax={100}
					><span class="fill" style="width:{Math.round(e.r2 * 100)}%"></span></span>
					<span class="pct">{Math.round(e.r2 * 100)}%</span>
				</li>
			{/each}
		</ul>
		<p class="note">Small or nonlinear relationships may not appear; use this as a ranking, not a complete account of uncertainty.</p>
	</div>
{:else}
	<div class="sens">
		<h3>Sensitivity</h3>
		<p class="note">No sensitivity scores are available. Variables sharing this result’s samples, unmeasurable correlations, and scores below r² = 0.01 are omitted. Missing scores do not mean the inputs are unimportant.</p>
	</div>
{/if}

<style>
	.sens h3 {
		margin: 0.25rem 0;
		color: var(--accent-soft);
		font-weight: 600;
		font-size: 0.85rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	li {
		display: grid;
		grid-template-columns: 5rem 1fr 2.5rem;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
	}
	.name {
		font-family: var(--font-mono);
		color: var(--accent-soft);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bar {
		height: 8px;
		background: var(--surface-2);
		border-radius: 4px;
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--color-brand);
	}
	.pct {
		text-align: right;
		color: var(--text-muted);
		font-family: var(--font-mono);
	}
	.note {
		margin: 0.35rem 0 0;
		color: var(--text-faint);
		font-size: 0.72rem;
		line-height: 1.4;
	}
</style>
