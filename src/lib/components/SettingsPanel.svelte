<script lang="ts">
// Presentation-only: the settings panel. It floats over the sheet (top-right,
// like Sheets/Help) rather than reflowing the page. Everyday controls (number
// format, confidence, sample count) sit up front; power knobs (calendar
// conventions, custom units, AST toggle, seed) fold into an "Advanced"
// disclosure, and the whole-database Export/Import + destructive actions live
// in stacked cards below — so a newcomer isn't shown all of it at once.
import type { NumberFormat } from '$lib/engine';
import type { SheetController } from '$lib/state/sheet.svelte';
import ConfidenceExplainer from './ConfidenceExplainer.svelte';
import FloatingPanel from './FloatingPanel.svelte';

let { c }: { c: SheetController } = $props();

const THEMES: { value: 'system' | 'light' | 'dark'; label: string }[] = [
	{ value: 'system', label: 'System' },
	{ value: 'light', label: 'Light' },
	{ value: 'dark', label: 'Dark' }
];

const NUMBER_FORMATS: { value: NumberFormat; label: string; hint: string }[] = [
	{ value: 'auto', label: 'Auto', hint: '1.04B — picks per value' },
	{ value: 'compact', label: '1M / 1B', hint: 'short-scale suffixes' },
	{ value: 'newspaper', label: '1 million', hint: 'spelled-out scale words' },
	{ value: 'scientific', label: '1e9', hint: 'scientific notation' }
];

// The calendar conventions are precise fractions (a Gregorian month is
// 365.2425/12 = 30.436875 days), which read as noise in the input. Trim the
// *display* to a few decimals; the stored value keeps full precision until the
// user actually edits it.
const trim = (n: number) => +n.toFixed(4);

let jsonInput = $state<HTMLInputElement>();
let dbInput = $state<HTMLInputElement>();

// Hand a picked file to the controller, then clear the input so picking the
// same file again still fires a change event.
function pick(e: Event, handler: (f: File) => void) {
	const input = e.target as HTMLInputElement;
	const file = input.files?.[0];
	if (file) handler(file);
	input.value = '';
}
</script>

<FloatingPanel label="settings" width="400px">
	<div class="stack">
	<header class="head">
		<h2>Settings</h2>
		<button type="button" class="close" aria-label="close settings" onclick={() => c.toggleSettings()}>✕</button>
	</header>

	<!-- Everyday controls a casual user reaches for: how numbers read, the
	     confidence band, and the Monte-Carlo sample count. -->
	<div class="grp" role="group" aria-label="theme">
		<span class="grp-label">theme</span>
		{#each THEMES as t (t.value)}
			<button type="button" aria-pressed={c.theme === t.value} class:active={c.theme === t.value} onclick={() => c.setTheme(t.value)}>{t.label}</button>
		{/each}
	</div>

	<div class="grp" role="group" aria-label="number format">
		<span class="grp-label">numbers</span>
		{#each NUMBER_FORMATS as f (f.value)}
			<button type="button" class:active={c.numberFormat === f.value} title={f.hint} onclick={() => c.setNumberFormat(f.value)}>{f.label}</button>
		{/each}
	</div>

	<ConfidenceExplainer level={c.confidence} onCommit={(lv) => c.setConfidence(lv)} />

	<div class="grp" role="group" aria-label="sampling">
		<span class="grp-label">sampling</span>
		<label>N <input type="number" min="1" step="1" value={c.samples} onchange={(e) => { c.setSamples(e.currentTarget.valueAsNumber); e.currentTarget.value = String(c.samples); }} /></label>
		<span class="muted">all compute is local</span>
	</div>

	<!-- Power knobs folded away so a newcomer isn't shown calendar fractions,
	     custom units, and an AST toggle next to the basics. -->
	<details class="advanced disclosure">
		<summary><span class="caret" aria-hidden="true">▸</span>Advanced</summary>
		<div class="adv-row">
			<div class="grp">
				<span class="grp-label">calendar</span>
				<label>month <input type="number" min="0" step="any" value={trim(c.monthDays)} onchange={(e) => { c.setCalendarDays('monthDays', e.currentTarget.valueAsNumber); e.currentTarget.value = String(trim(c.monthDays)); }} /> d</label>
				<label>year <input type="number" min="0" step="any" value={trim(c.yearDays)} onchange={(e) => { c.setCalendarDays('yearDays', e.currentTarget.valueAsNumber); e.currentTarget.value = String(trim(c.yearDays)); }} /> d</label>
			</div>

			<span class="divider" aria-hidden="true"></span>

			<div class="grp units" role="group" aria-label="custom units">
				<span class="grp-label">units</span>
				{#each Object.entries(c.customUnits) as [name, def] (name)}
					<span class="chip" title={def}>{name}<button type="button" aria-label="remove {name}" onclick={() => c.removeCustomUnit(name)}>✕</button></span>
				{/each}
				<input
					class="unit-input"
					placeholder="sprint = 2 week"
					bind:value={c.newUnit}
					onkeydown={(e) => { if (e.key === 'Enter') c.applyCustomUnit(); }}
				/>
				<button type="button" onclick={() => c.applyCustomUnit()}>Add</button>
				{#if c.unitError}<span class="unit-err">{c.unitError}</span>{/if}
			</div>

			<span class="divider" aria-hidden="true"></span>

			<div class="grp">
				<span class="grp-label">view</span>
				<label class="debug-toggle">
					<input type="checkbox" checked={c.debugAst} onchange={() => c.toggleDebug()} />
					parsed AST in gutter <span class="kbd-inline">⌘D</span>
				</label>
			</div>

			<span class="muted">seed {c.seedHex}</span>
		</div>
	</details>

	<div class="sections">
		<!-- Whole-database backup/restore. Per-sheet outputs (copy/share, txt/md/csv)
		     stay in the toolbar's Copy menu; this is the all-of-it backup. -->
		<section class="card" aria-label="export and import">
			<p class="card-label">Export &amp; Import</p>
			<div class="rows">
				<div class="row">
					<div class="row-text">
						<p class="row-title">Export backup</p>
						<p class="row-desc">All sheets, custom units &amp; settings as a versioned <span class="mono">.json</span>.</p>
					</div>
					<button type="button" class="act" onclick={() => c.exportJson()}>Export JSON</button>
				</div>
				<div class="row">
					<div class="row-text">
						<p class="row-title">Import backup</p>
						<p class="row-desc">Merge from a calcy <span class="mono">.json</span> — existing data is kept.</p>
					</div>
					<button type="button" class="act" onclick={() => jsonInput?.click()}>Import JSON</button>
					<input bind:this={jsonInput} type="file" accept=".json,application/json" onchange={(e) => pick(e, (f) => c.importJson(f))} hidden />
				</div>
				<div class="row">
					<div class="row-text">
						<p class="row-title">Export database</p>
						<p class="row-desc">The full on-device database as a <span class="mono">.sqlite</span> file.</p>
					</div>
					<button type="button" class="act" onclick={() => c.exportDb()}>Export .sqlite</button>
				</div>
				<div class="row">
					<div class="row-text">
						<p class="row-title">Import database</p>
						<p class="row-desc">Replace <em>everything</em> with a <span class="mono">.sqlite</span> backup.</p>
					</div>
					<button type="button" class="act" onclick={() => dbInput?.click()}>Import .sqlite</button>
					<input bind:this={dbInput} type="file" accept=".sqlite" onchange={(e) => pick(e, (f) => c.importDb(f))} hidden />
				</div>
			</div>
			{#if c.dataMessage}
				<p class="data-msg" class:err={c.dataError} role="status">{c.dataMessage}</p>
			{/if}
		</section>

		<!-- Reversible-ish destructive actions. -->
		<section class="card danger" aria-label="danger zone">
			<p class="card-label danger-label">Danger zone</p>
			<div class="rows">
				<div class="row">
					<div class="row-text">
						<p class="row-title">Clear all sheets</p>
						<p class="row-desc">Delete every sheet and its history. Custom units &amp; settings are kept.</p>
					</div>
					<button type="button" class="act danger-btn" onclick={() => c.clearAllSheets()}>Clear</button>
				</div>
				<div class="row">
					<div class="row-text">
						<p class="row-title">Reset settings &amp; custom units</p>
						<p class="row-desc">Restore defaults and remove custom units. Your sheets are kept.</p>
					</div>
					<button type="button" class="act danger-btn" onclick={() => c.resetUserData()}>Reset</button>
				</div>
			</div>
		</section>

		<!-- The nuclear option, folded away behind its own disclosure. -->
		<details class="card danger dragons disclosure" aria-label="here be dragons">
			<summary class="card-label danger-label"><span class="caret" aria-hidden="true">▸</span>🐉 Here be dragons</summary>
			<div class="rows">
				<div class="row">
					<div class="row-text">
						<p class="row-title">Wipe all on-device storage</p>
						<p class="row-desc">Erase the entire database — every sheet, revision, unit &amp; setting — and reset calcy to a clean slate. Cannot be undone.</p>
					</div>
					<button type="button" class="act danger-btn" onclick={() => c.wipeStorage()}>Wipe</button>
				</div>
			</div>
		</details>
	</div>
	</div>
</FloatingPanel>

<style>
	/* The panel floats (FloatingPanel owns the box chrome); inside, controls
	   stack vertically with a little breathing room between clusters. */
	.stack {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.head h2 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--text);
	}
	.close {
		background: none;
		border: none;
		color: var(--text-faint);
		cursor: pointer;
		font-size: 0.95rem;
		line-height: 1;
		padding: 0.15rem 0.3rem;
		border-radius: 6px;
	}
	.close:hover {
		color: var(--text);
		background: var(--surface-3);
	}
	.stack label {
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.stack input[type='number'] {
		width: 7rem;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		color: var(--text);
		border-radius: 6px;
		padding: 0.2rem 0.4rem;
	}
	/* Each setting cluster is a labelled group of inline controls that wraps as
	   needed within the panel's width. */
	.grp {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-wrap: wrap;
	}
	.grp-label {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-muted);
		margin-right: 0.15rem;
	}
	.grp > button {
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		color: var(--text-2);
		padding: 0.2rem 0.5rem;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
		font-family: var(--font-mono);
	}
	.grp > button:hover {
		border-color: var(--color-brand);
	}
	.grp > button.active {
		background: var(--color-brand);
		color: var(--text);
		border-color: var(--color-brand);
	}
	.muted {
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	/* Disclosures (Advanced, Here be dragons) hide the native marker and supply
	   their own caret so it's unmistakably an expand/collapse control. */
	.disclosure > summary {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		cursor: pointer;
		list-style: none;
	}
	.disclosure > summary::-webkit-details-marker {
		display: none;
	}
	.caret {
		display: inline-block;
		font-size: 0.7em;
		color: var(--text-muted);
		transition: transform 0.12s ease;
	}
	.disclosure[open] > summary > .caret {
		transform: rotate(90deg);
	}
	.advanced > summary {
		width: max-content;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-muted);
		padding: 0.15rem 0;
	}
	.advanced > summary:hover {
		color: var(--text-2);
	}
	.adv-row {
		display: flex;
		gap: 0.65rem;
		flex-wrap: wrap;
		align-items: center;
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}
	/* Stacked cards (Export & Import / Danger zone / Here be dragons). */
	.sections {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.card {
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-2);
		padding: 0.5rem 0.75rem;
	}
	.card.danger {
		border-color: var(--danger-border);
	}
	.card-label {
		margin: 0 0 0.2rem;
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-muted);
	}
	.danger-label {
		color: var(--c-error);
	}
	.rows {
		display: flex;
		flex-direction: column;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.45rem 0;
	}
	.row + .row {
		border-top: 1px solid var(--border);
	}
	.row-text {
		min-width: 0;
	}
	.row-title {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text);
	}
	.row-desc {
		margin: 0.1rem 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.act {
		flex-shrink: 0;
		background: var(--surface-1);
		border: 1px solid var(--border-strong);
		color: var(--text-2);
		padding: 0.3rem 0.6rem;
		border-radius: 7px;
		cursor: pointer;
		font-size: 0.8rem;
	}
	.act:hover {
		border-color: var(--color-brand);
		color: var(--text);
	}
	.danger-btn {
		color: var(--c-error);
		border-color: var(--danger-border);
	}
	.danger-btn:hover {
		border-color: var(--c-error);
		background: var(--danger-bg);
		color: var(--c-error);
	}
	.data-msg {
		margin: 0.5rem 0 0;
		font-size: 0.78rem;
		color: var(--text-2);
	}
	.data-msg.err {
		color: var(--c-error);
	}
	.dragons[open] > summary {
		margin-bottom: 0.4rem;
	}
	.debug-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.debug-toggle input[type='checkbox'] {
		accent-color: var(--color-brand);
	}
	.kbd-inline {
		display: inline-block;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		padding: 0 0.3rem;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--text-2);
		margin-left: 0.3rem;
	}
	.unit-input {
		width: 11rem;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		color: var(--text);
		border-radius: 6px;
		padding: 0.2rem 0.4rem;
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		background: var(--surface-accent);
		border: 1px solid var(--border-accent);
		color: var(--accent-soft);
		border-radius: 999px;
		padding: 0.1rem 0.2rem 0.1rem 0.55rem;
		font-family: var(--font-mono);
		font-size: 0.78rem;
	}
	.chip button {
		border: none;
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		padding: 0 0.25rem;
		font-size: 0.7rem;
	}
	.chip button:hover {
		color: var(--c-error);
	}
	.unit-err {
		color: var(--c-error);
		font-size: 0.78rem;
	}
</style>
