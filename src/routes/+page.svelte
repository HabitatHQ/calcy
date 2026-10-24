<script lang="ts">
// The view shell: instantiate the controller, wire lifecycle + keyboard, and
// compose the presentation components. All logic lives in SheetController and
// the pure core under $lib/sheet/*; this file holds layout only.
import { onMount } from 'svelte';
import Footer from '$lib/components/Footer.svelte';
import GuidePanel from '$lib/components/GuidePanel.svelte';
import Gutter from '$lib/components/Gutter.svelte';
import Header from '$lib/components/Header.svelte';
import HelpPanel from '$lib/components/HelpPanel.svelte';
import HistoryPanel from '$lib/components/HistoryPanel.svelte';
import HowItWorksPanel from '$lib/components/HowItWorksPanel.svelte';
import ReferencePanel from '$lib/components/ReferencePanel.svelte';
import Inspector from '$lib/components/Inspector.svelte';
import Notepad from '$lib/components/Notepad.svelte';
import SettingsPanel from '$lib/components/SettingsPanel.svelte';
import SheetsPanel from '$lib/components/SheetsPanel.svelte';
import Splitter from '$lib/components/Splitter.svelte';
import Tape from '$lib/components/Tape.svelte';
import TemplatesPanel from '$lib/components/TemplatesPanel.svelte';
import { keyToIntent } from '$lib/sheet/keymap';
import { SheetController } from '$lib/state/sheet.svelte';
import { TEMPLATES } from '$lib/templates';

// Per-column pixel floors. Below these, content starts to clip badly:
// editor below 240 leaves no room for autocomplete, gutter below 160
// truncates distribution text, inspector below 280 hides the rate card.
const MIN_EDITOR = 240;
const MIN_GUTTER = 160;
const MIN_INSPECTOR = 280;

// Instantiated during component init so the controller's $effects bind to this
// component's lifecycle; workers spin up in boot() once we're mounted.
const c = new SheetController();
let notepad = $state<ReturnType<typeof Notepad>>();
let gutter = $state<ReturnType<typeof Gutter>>();

onMount(() => {
	c.boot();
	return () => c.destroy();
});

// Help's "insert snippet" prefers the live Notepad editor (cursor-aware) and
// falls back to appending. The component instance ref lives here in the view.
function insertSnippet(snippet: string) {
	if (c.mode !== 'notepad') c.setMode('notepad');
	if (notepad?.insertSnippet) notepad.insertSnippet(snippet);
	else c.appendLine(snippet);
}

function onKeydown(e: KeyboardEvent) {
	const intent = keyToIntent(e);
	if (!intent) return;
	if (intent.type === 'close') {
		c.closeOverlays();
		return;
	}
	e.preventDefault();
	switch (intent.type) {
		case 'toggle-sheets':
			c.toggleSheets();
			break;
		case 'toggle-help':
			c.toggleHelp();
			break;
		case 'toggle-debug':
			c.toggleDebug();
			break;
		case 'reroll':
			c.reroll();
			break;
	}
}

// Splitter 1 lives between editor and gutter. Moving it right widens the
// editor and narrows the gutter; the inspector keeps its width and the
// remaining space flows to it via flex. When the editor or gutter is
// collapsed, a single drag of this splitter re-expands it (to the
// column's stored width) and subsequent drags behave normally.
function onEditorResize(dx: number) {
	// Re-expand on the first positive drag if the editor is collapsed.
	if (c.editorCollapsed) {
		if (dx <= 0) return;
		c.editorCollapsed = false;
		c.editorWidth = Math.max(MIN_EDITOR, c.editorWidth);
		return;
	}
	if (c.gutterCollapsed) {
		if (dx >= 0) return;
		c.gutterCollapsed = false;
		c.gutterWidth = Math.max(MIN_GUTTER, c.gutterWidth);
		return;
	}
	const minLeft = MIN_EDITOR;
	const minRight = MIN_GUTTER;
	const maxLeft = Math.max(minLeft, window.innerWidth - c.gutterWidth - MIN_INSPECTOR - 12);
	const minDelta = minLeft - c.editorWidth;
	const maxDelta = maxLeft - c.editorWidth;
	const clamped = Math.min(maxDelta, Math.max(minDelta, dx));
	const nextEditor = c.editorWidth + clamped;
	const nextGutter = c.gutterWidth - clamped;
	if (nextGutter < minRight) return;
	c.editorWidth = nextEditor;
	c.gutterWidth = nextGutter;
}
// Splitter 2 lives between gutter and inspector. Moving it right widens the
// gutter and narrows the inspector. Same collapse-re-expand handling.
function onGutterResize(dx: number) {
	if (c.gutterCollapsed) {
		if (dx <= 0) return;
		c.gutterCollapsed = false;
		c.gutterWidth = Math.max(MIN_GUTTER, c.gutterWidth);
		return;
	}
	if (c.inspectorCollapsed) {
		if (dx >= 0) return;
		c.inspectorCollapsed = false;
		c.inspectorWidth = Math.max(MIN_INSPECTOR, c.inspectorWidth);
		return;
	}
	const minLeft = MIN_GUTTER;
	const minRight = MIN_INSPECTOR;
	const maxLeft = Math.max(
		minLeft,
		window.innerWidth - c.editorWidth - MIN_INSPECTOR - 12
	);
	const minDelta = minLeft - c.gutterWidth;
	const maxDelta = maxLeft - c.gutterWidth;
	const clamped = Math.min(maxDelta, Math.max(minDelta, dx));
	const nextGutter = c.gutterWidth + clamped;
	const nextInspector = c.inspectorWidth - clamped;
	if (nextInspector < minRight) return;
	c.gutterWidth = nextGutter;
	c.inspectorWidth = nextInspector;
}
// Persist on drag-end so the DB isn't hammered mid-gesture.
let persisting = false;
function persistLayout() {
	if (persisting) return;
	persisting = true;
	queueMicrotask(() => {
		persisting = false;
		c.setLayout(c.editorWidth, c.gutterWidth, c.inspectorWidth);
	});
}
</script>

<svelte:head><title>Calcy — {c.title}</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<div class="app">
	<Header {c} />

	{#if c.ephemeral}
		<div class="ephemeral-banner" role="status">
			⚠ calcy is already open in another tab, which owns your saved sheets.
			<strong>Changes in this tab won’t be saved.</strong> Close the other tabs and reload to
			save here.
		</div>
	{/if}

	{#if c.saveError}
		<div class="eval-error" role="alert">
			⚠ Couldn’t save your latest changes (storage may be full). Export your sheet to be safe.
		</div>
	{/if}

	{#if c.evalError}
		<div class="eval-error" role="alert">⚠ {c.evalError}</div>
	{/if}

	<main
		class="body"
		class:editor-collapsed={c.editorCollapsed}
		class:gutter-collapsed={c.gutterCollapsed}
		class:inspector-collapsed={c.inspectorCollapsed}
		style="--w-editor: {c.editorCollapsed ? 0 : c.editorWidth}px; --w-gutter: {c.gutterCollapsed ? 0 : c.gutterWidth}px; --w-inspector: {c.inspectorCollapsed ? 0 : c.inspectorWidth}px;"
	>
		<section class="editor" aria-label="calculator">
			{#if c.mode === 'notepad'}
				<Notepad bind:this={notepad} bind:value={c.body} lines={c.results} selected={c.selected} unitNames={c.unitNames} templates={TEMPLATES} showAst={c.debugAst} dark={c.isDark} onselect={(i) => c.select(i)} onloadtemplate={(t) => c.loadTemplate(t)} onscrolltop={(top) => gutter?.setScrollTop(top)} />
			{:else if c.engine}
				<Tape onexpr={(expr, append) => c.applyTapeExpr(expr, append)} seed={c.seed} samples={c.samples} numberFormat={c.numberFormat} monthDays={c.monthDays} yearDays={c.yearDays} confidence={c.confidence} customUnits={c.customUnits} showAst={c.debugAst} />
			{/if}
		</section>

		{#if c.mode === 'notepad'}
			<Splitter
				min={MIN_EDITOR}
				leftCollapsed={c.editorCollapsed}
				rightCollapsed={c.gutterCollapsed}
				onresize={(dx) => {
					onEditorResize(dx);
				}}
				onresizeend={persistLayout}
				onlefttoggle={() => c.toggleEditor()}
				onrighttoggle={() => c.toggleGutter()}
			/>
			<section class="gutter-col" aria-label="line results">
				<Gutter bind:this={gutter} lines={c.results} selected={c.selected} onselect={(i) => c.select(i)} oncopy={(i) => c.copyLineAt(i)} oninsert={(text) => insertSnippet(text)} showAst={c.debugAst} blank={c.blank} />
			</section>
			<Splitter
				min={MIN_INSPECTOR}
				leftCollapsed={c.gutterCollapsed}
				rightCollapsed={c.inspectorCollapsed}
				onresize={(dx) => {
					onGutterResize(dx);
				}}
				onresizeend={persistLayout}
				onlefttoggle={() => c.toggleGutter()}
				onrighttoggle={() => c.toggleInspector()}
			/>
		{/if}

		<section class="inspector-col" aria-label="line detail">
			<Inspector {c} />
		</section>
	</main>

	<Footer {c} />

	{#if c.showSheets || c.showHelp || c.showHistory || c.showTemplates || c.showSettings}
		<button class="backdrop" aria-label="close" onclick={() => c.closeOverlays()}></button>
	{/if}

	{#if c.showSettings}
		<SettingsPanel {c} />
	{/if}

	{#if c.showHelp}
		<HelpPanel
			oninsert={insertSnippet}
			onguide={() => c.openGuide()}
			onreference={() => c.openReference()}
			onhowitworks={() => c.openHowItWorks()}
			onclose={() => (c.showHelp = false)}
			topic={c.helpTopic}
		/>
	{/if}
	{#if c.showGuide}
		<GuidePanel onclose={() => (c.showGuide = false)} />
	{/if}
	{#if c.showReference}
		<ReferencePanel onclose={() => (c.showReference = false)} />
	{/if}
	{#if c.showHowItWorks}
		<HowItWorksPanel onclose={() => (c.showHowItWorks = false)} />
	{/if}
	{#if c.showTemplates}
		<TemplatesPanel {c} />
	{/if}
	{#if c.showSheets}
		<SheetsPanel {c} />
	{/if}
	{#if c.showHistory}
		<HistoryPanel {c} />
	{/if}
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		height: 100dvh;
	}
	.body {
		flex: 1;
		display: flex;
		gap: 0;
		padding: 0.75rem;
		min-height: 0;
		overflow: hidden;
	}
	.editor {
		width: var(--w-editor);
		min-width: 0;
		display: flex;
		flex-shrink: 0;
	}
	.editor > :global(*) {
		flex: 1;
	}
	.gutter-col {
		width: var(--w-gutter);
		min-width: 0;
		display: flex;
		flex-shrink: 0;
	}
	/* Stretch the gutter box to fill its column. Without this it sizes to its
	   content, so an empty gutter (e.g. the onboarding state) collapses to a
	   thin sliver and leaves a dead gap before the inspector. Mirrors the
	   .editor / .inspector-col child rules. */
	.gutter-col > :global(*) {
		flex: 1;
	}
	.inspector-col {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
	}
	.inspector-col > :global(*) {
		flex: 1;
	}
	.backdrop {
		position: fixed;
		inset: 0;
		/* A dim scrim so a floating panel reads as an overlay above the sheet
		   rather than data randomly covering the results grid. */
		background: var(--scrim);
		border: none;
		padding: 0;
		margin: 0;
		z-index: 15;
		cursor: default;
	}
	.eval-error {
		color: var(--c-error);
		background: var(--danger-bg);
		border-bottom: 1px solid var(--danger-border);
		padding: 0.4rem 0.9rem;
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}
	.ephemeral-banner {
		color: var(--warn);
		background: var(--warn-bg);
		border-bottom: 1px solid var(--warn-border);
		padding: 0.45rem 0.9rem;
		font-size: 0.82rem;
	}
	.ephemeral-banner strong {
		color: var(--warn-soft);
	}

	@media (max-width: 820px) {
		/* On narrow viewports, drop the gutter and splitters and stack the editor
		   above the inspector so each spans the full width — otherwise the results
		   grid's columns overflow off-screen and the answers can't be read. */
		.gutter-col,
		.body > :global(.splitter) {
			display: none;
		}
		.body {
			flex-direction: column;
			overflow: auto;
		}
		.editor,
		.inspector-col {
			width: auto;
			flex: 1 1 auto;
			min-height: 45vh;
		}
	}
</style>