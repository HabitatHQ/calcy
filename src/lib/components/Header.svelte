<script lang="ts">
// Presentation-only: the top toolbar. Title binds to the controller; every
// button forwards an intent to it.
//
// Controls are grouped into clusters separated by hairline dividers — a
// segmented mode toggle, a Sheets menu, a Copy/export menu plus re-roll, and
// icon-only utilities — so the bar reads as a few small toolbars instead of one
// wall of identical pills.
import type { SheetController } from '$lib/state/sheet.svelte';
import Menu from './Menu.svelte';

let { c }: { c: SheetController } = $props();

// The Copy trigger doubles as transient confirmation: a successful copy/share
// flips the label for ~1.2s (controller-driven) so the feedback survives the
// menu closing.
const copyLabel = $derived(c.copied ? '✓ Copied' : c.shared ? '✓ Link' : 'Copy');

// Hidden file input for "Import .sqlite"; the menu item just clicks it.
let importInput = $state<HTMLInputElement>();
function onImport(e: Event) {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (file) c.importDb(file);
}
</script>

<header>
	<strong class="logo">calcy</strong>
	<input class="title" bind:value={c.title} aria-label="sheet title" />
	<div class="spacer"></div>

	<div class="modes" role="tablist" aria-label="editor mode">
		<button role="tab" aria-selected={c.mode === 'notepad'} class:active={c.mode === 'notepad'} onclick={() => c.setMode('notepad')}>Notepad</button>
		<button role="tab" aria-selected={c.mode === 'tape'} class:active={c.mode === 'tape'} onclick={() => c.setMode('tape')}>Tape</button>
	</div>

	<span class="divider" aria-hidden="true"></span>

	<div class="group" aria-label="sheets">
		<Menu label="Sheets" title="Sheets" active={c.showTemplates || c.showSheets || c.showHistory}>
			{#snippet children({ close })}
				<button role="menuitem" onclick={() => { c.newSheet(); close(); }}>New sheet</button>
				<div role="separator"></div>
				<button role="menuitem" onclick={() => { c.toggleTemplates(); close(); }}>Start from an example…</button>
				<button role="menuitem" onclick={() => { c.toggleSheets(); close(); }}>Browse sheets…<span class="hint">⌘K</span></button>
				<button role="menuitem" onclick={() => { c.openHistory(); close(); }}>Revision history…</button>
			{/snippet}
		</Menu>
	</div>

	<span class="divider" aria-hidden="true"></span>

	<div class="group" aria-label="copy, export & recompute">
		<Menu label={copyLabel} title="Copy & export" active={c.copied || c.shared}>
			{#snippet children({ close })}
				<button role="menuitem" onclick={() => { c.copySheet(); close(); }}>Copy sheet + results</button>
				<button role="menuitem" onclick={() => { c.shareLink(); close(); }}>Copy share link</button>
				<div role="separator"></div>
				<button role="menuitem" onclick={() => { c.exportTxt(); close(); }}>Download<span class="hint">.txt</span></button>
				<button role="menuitem" onclick={() => { c.exportMd(); close(); }}>Download<span class="hint">.md</span></button>
				<button role="menuitem" onclick={() => { c.exportCsv(); close(); }}>Download<span class="hint">.csv</span></button>
				<div role="separator"></div>
				<button role="menuitem" onclick={() => { c.exportDb(); close(); }}>Export database<span class="hint">.sqlite</span></button>
				<button role="menuitem" onclick={() => { importInput?.click(); close(); }}>Import database…<span class="hint">.sqlite</span></button>
			{/snippet}
		</Menu>
		<input bind:this={importInput} type="file" accept=".sqlite" onchange={onImport} hidden />
		<button class="icon" class:pulse={c.rerolled} onclick={() => c.reroll()} title="Resample with a new seed (⌘↵)" aria-label="re-roll">↻</button>
	</div>

	<span class="divider" aria-hidden="true"></span>

	<div class="group" aria-label="help & settings">
		<button class="icon" class:active={c.showHelp} onclick={() => c.toggleHelp()} title="Syntax cheat sheet (⌘/)" aria-label="help">?</button>
		<button class="icon" class:active={c.showSettings} onclick={() => c.toggleSettings()} title="Settings" aria-label="settings">⚙</button>
	</div>
</header>

<style>
	header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface-1);
		flex-wrap: wrap;
	}
	.logo {
		color: var(--color-brand);
		font-weight: 800;
		letter-spacing: -0.02em;
	}
	.title {
		background: transparent;
		border: 1px solid transparent;
		color: var(--text);
		font-size: 1rem;
		padding: 0.2rem 0.4rem;
		border-radius: 6px;
		min-width: 6rem;
	}
	.title:hover,
	.title:focus {
		border-color: var(--border-strong);
		outline: none;
	}
	.spacer {
		flex: 1;
		min-width: 0.5rem;
	}
	/* A cluster of related buttons. */
	.group {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	/* Hairline separator between clusters. */
	.divider {
		align-self: stretch;
		width: 1px;
		min-height: 1.4rem;
		background: var(--border);
		margin: 0 0.15rem;
	}
	header button {
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-2);
		padding: 0.3rem 0.6rem;
		border-radius: 7px;
		cursor: pointer;
		font-size: 0.85rem;
	}
	header button:hover {
		border-color: var(--color-brand);
	}
	header button.active {
		border-color: var(--color-brand);
		color: var(--text);
		background: var(--surface-accent);
	}
	/* Square icon buttons (Re-roll / help / settings) — uniform footprint so the
	   utility cluster reads as glyphs, not labelled actions. */
	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		padding: 0.3rem 0;
		font-size: 0.95rem;
		line-height: 1;
	}
	/* Segmented mode toggle: one connected control, not two loose pills, so it
	   visibly means "pick a mode" rather than "do an action". */
	.modes {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.modes button {
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-2);
		padding: 0.25rem 0.7rem;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.modes button:hover {
		color: var(--text);
	}
	.modes button.active {
		background: var(--color-brand);
		color: var(--text);
		border-color: var(--color-brand);
	}
	@keyframes pulse {
		0% {
			box-shadow: 0 0 0 0 rgb(var(--color-accent-rgb) / 0.6);
		}
		100% {
			box-shadow: 0 0 0 8px rgb(var(--color-accent-rgb) / 0);
		}
	}
	header button.pulse {
		animation: pulse 0.45s ease-out;
		border-color: var(--color-brand);
	}

	/* On narrow widths the row wraps; drop the dividers so wrapped clusters don't
	   leave stray vertical ticks. */
	@media (max-width: 820px) {
		.divider {
			display: none;
		}
	}
</style>
