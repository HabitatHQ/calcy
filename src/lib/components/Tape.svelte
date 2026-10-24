<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { astText, type LineResult, type NumberFormat } from '$lib/engine';
import { EngineClient } from '$lib/engine/client';
import { type TapeOp, type TapeRow, tapePrefix, tapeSheet } from '$lib/tape';
import Sparkline from './Sparkline.svelte';

// Tape owns a separate worker so evaluations cannot replace Notepad's inspector
// snapshot. Its worker is disposed with this component on mode switches.
let {
	seed,
	samples,
	numberFormat = 'auto',
	monthDays,
	yearDays,
	confidence,
	customUnits = {},
	showAst = false,
	onexpr
}: {
	seed: number;
	samples: number;
	numberFormat?: NumberFormat;
	monthDays: number;
	yearDays: number;
	confidence: number;
	customUnits?: Record<string, string>;
	showAst?: boolean;
	onexpr: (expr: string, append: boolean) => void;
} = $props();

let engine = $state<EngineClient>();
let disposed = false;
onMount(() => { engine = new EngineClient(); });
onDestroy(() => {
	disposed = true;
	engine?.destroy();
});

let rows = $state<TapeRow[]>([{ op: '=', operand: '1000 req/s' }]);
let running = $state<LineResult[]>([]);

const OPS: TapeOp[] = ['+', '-', '*', '/'];
const SYM: Record<string, string> = { '*': '×', '/': '÷', '+': '+', '-': '−', '=': '' };

const fullExpr = $derived(tapePrefix(rows, rows.length - 1));
const finalResult = $derived(running[rows.length - 1]);
const finalHist = $derived(
	finalResult?.isDist && finalResult.summary?.kind === 'dist' ? finalResult.summary.hist : null
);
const finalAst = $derived(showAst && finalResult?.ast ? astText(finalResult.ast) : '');
const rowHist = (i: number) => {
	const r = running[i];
	return r?.isDist && r.summary?.kind === 'dist' ? r.summary.hist : null;
};
const rowAst = (i: number): string => {
	if (!showAst) return '';
	const r = running[i];
	return r?.ast ? astText(r.ast) : '';
};

// Per-row copy-result affordance, mirroring the Gutter's onCopyClick: copy
// the row's formatted result and show a brief "✓" tick.
let justCopied = $state<number | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
async function copyRow(i: number) {
	const t = running[i]?.display?.text;
	if (!t) return;
	await navigator.clipboard.writeText(t);
	justCopied = i;
	if (copyTimer) clearTimeout(copyTimer);
	copyTimer = setTimeout(() => (justCopied = null), 1200);
}

async function recompute() {
	if (!engine || disposed) return;
	const revision = ++evaluationRevision;
	try {
		const result = await engine.evalSheet(
			tapeSheet(rows),
			{ seed, N: samples, numberFormat, monthDays, yearDays, confidence },
			customUnits
		);
		if (!disposed && revision === evaluationRevision) running = result.lines;
	} catch {
		// The owned worker may be disposed while an evaluation is in flight.
	}
}
let evaluationRevision = 0;

$effect(() => {
	void JSON.stringify(rows);
	void seed;
	void samples;
	void numberFormat;
	void monthDays;
	void yearDays;
	void confidence;
	void customUnits;
	recompute();
});

function addRow(op: TapeOp) {
	rows = [...rows, { op, operand: '' }];
}
function removeRow(i: number) {
	if (i === 0) return;
	rows = rows.filter((_, k) => k !== i);
}
function duplicate(i: number) {
	rows = [...rows.slice(0, i + 1), { ...rows[i] }, ...rows.slice(i + 1)];
}
function reset() {
	rows = [{ op: '=', operand: '1000 req/s' }];
}

// Swipe-to-duplicate (right) / swipe-to-remove (left) — mirrors the source app.
let swipeStartX = 0;
let swipeRow = -1;
function onTouchStart(i: number, e: TouchEvent) {
	swipeRow = i;
	swipeStartX = e.touches[0].clientX;
}
function onTouchEnd(e: TouchEvent) {
	if (swipeRow < 0) return;
	const dx = e.changedTouches[0].clientX - swipeStartX;
	if (dx > 60) duplicate(swipeRow);
	else if (dx < -60) removeRow(swipeRow);
	swipeRow = -1;
}
</script>

<div class="tape">
	<div class="readout" class:err={!!finalResult?.error}>
		<span class="label">running total</span>
		<span class="value">{finalResult?.error ? `⚠ ${finalResult.error}` : (finalResult?.display?.text ?? '—')}</span>
		{#if finalHist}
			<Sparkline hist={finalHist} width={220} height={36} />
		{/if}
		{#if finalAst}
			<span class="ast" aria-label="parsed AST">{finalAst}</span>
		{/if}
	</div>

	<div class="rows">
		{#each rows as row, i (i)}
			<div
				class="row"
				role="group"
				aria-label="step {i + 1}"
				ontouchstart={(e) => onTouchStart(i, e)}
				ontouchend={onTouchEnd}
			>
				<span class="op">{SYM[row.op]}</span>
				<div class="operand">
					<input
						bind:value={row.operand}
						placeholder={i === 0 ? 'start value' : 'operand (e.g. 10 to 30 kg)'}
						aria-label="operand {i}"
						inputmode="text"
					/>
					<span class="run" class:err={!!running[i]?.error}>
						{#if rowHist(i)}<Sparkline hist={rowHist(i) ?? []} width={34} height={14} />{/if}
						{running[i]?.error ? '⚠' : (running[i]?.display?.text ?? '')}
					</span>
					{#if rowAst(i)}
						<span class="ast" aria-label="parsed AST">{rowAst(i)}</span>
					{/if}
				</div>
				<button
					type="button"
					class="icon"
					class:copied={justCopied === i}
					onclick={() => copyRow(i)}
					aria-label="copy step result"
					title="copy result"
					disabled={!running[i]?.display}
				>{justCopied === i ? '✓' : '⧉'}</button>
				<button class="icon" onclick={() => duplicate(i)} aria-label="duplicate row" title="duplicate (swipe right)">⎘</button>
				{#if i > 0}
					<button class="icon" onclick={() => removeRow(i)} aria-label="remove row" title="remove (swipe left)">✕</button>
				{/if}
			</div>
		{/each}
	</div>

	<div class="ops">
		{#each OPS as op (op)}
			<button class="big" onclick={() => addRow(op)} aria-label="add {op} step">{SYM[op]}</button>
		{/each}
		<div class="ops-spacer"></div>
		<button class="ghost" onclick={reset}>reset</button>
		<button class="ghost" onclick={() => onexpr(fullExpr, true)}>→ notepad</button>
	</div>
</div>

<style>
	.tape {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 320px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-1);
		overflow: hidden;
	}
	.readout {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface-1);
	}
	.readout .label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	.readout .value {
		font-family: var(--font-mono);
		font-size: 1.5rem;
		color: var(--c-value);
		word-break: break-word;
	}
	.readout.err .value {
		color: var(--c-error);
		font-size: 1rem;
	}
	.rows {
		flex: 1;
		overflow: auto;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		touch-action: pan-y;
	}
	.op {
		width: 1.6rem;
		text-align: center;
		font-size: 1.4rem;
		color: var(--color-brand);
		font-family: var(--font-mono);
		flex-shrink: 0;
	}
	.operand {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.operand input {
		width: 100%;
		min-height: 48px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text);
		border-radius: 10px;
		padding: 0.5rem 0.7rem;
		font-family: var(--font-mono);
		font-size: 1.05rem;
	}
	.operand input:focus {
		outline: none;
		border-color: var(--color-brand);
	}
	.run {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding-left: 0.2rem;
		font-family: var(--font-mono);
		color: var(--text-muted);
		font-size: 0.85rem;
		min-height: 1rem;
	}
	.run.err {
		color: var(--c-error);
	}
	.ast {
		display: block;
		font-size: 0.72rem;
		line-height: 1.3;
		color: var(--text-faint);
		padding: 0 0.2rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.readout .ast {
		padding: 0;
	}
	.icon {
		flex-shrink: 0;
		width: 44px;
		height: 44px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		color: var(--text-muted);
		cursor: pointer;
		font-size: 1rem;
		border-radius: 10px;
	}
	.icon:hover {
		border-color: var(--color-brand);
		color: var(--text);
	}
	.icon:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.icon.copied {
		color: var(--color-brand);
		border-color: var(--color-brand);
	}
	.ops {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem;
		border-top: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.ops-spacer {
		flex: 1;
	}
	.big {
		width: 56px;
		height: 56px;
		font-size: 1.6rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text);
		border-radius: 12px;
		cursor: pointer;
	}
	.big:hover {
		border-color: var(--color-brand);
	}
	.big:active {
		background: var(--surface-accent);
	}
	.ghost {
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-2);
		border-radius: 10px;
		padding: 0 1rem;
		height: 44px;
		cursor: pointer;
	}
	.ghost:hover {
		border-color: var(--color-brand);
	}
</style>
