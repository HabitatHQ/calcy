<script lang="ts">
// Presentation-only: start a new sheet from a built-in template.
import type { SheetController } from '$lib/state/sheet.svelte';
import { TEMPLATES } from '$lib/templates';
import EntryList, { type Entry } from './EntryList.svelte';
import FloatingPanel from './FloatingPanel.svelte';

let { c }: { c: SheetController } = $props();

const entries: Entry[] = TEMPLATES.map((t) => ({ id: t.title, title: t.title, subtitle: t.blurb }));
const byTitle = new Map(TEMPLATES.map((t) => [t.title, t]));
</script>

<FloatingPanel label="examples">
	<div class="hist-head">
		<span class="fmt-label">start from an example</span>
	</div>
	<p class="intro">
		Explore a worked example, then adapt it. If your current sheet has content, the example opens
		in a separate sheet, leaving your work unchanged.
	</p>
	<button
		class="guide"
		onclick={() => {
			c.closeOverlays();
			c.openGuide();
		}}
	>Read the Guide</button>
	<EntryList
		items={entries}
		onpick={(id) => {
			const t = byTitle.get(id);
			if (t) c.newFromTemplate(t);
		}}
	/>
</FloatingPanel>

<style>
	.hist-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}
	.fmt-label {
		font-size: 0.85rem;
		color: var(--text-2);
		margin-right: 0.1rem;
	}
	.intro {
		margin: 0 0 0.5rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		line-height: 1.45;
	}
	.guide {
		align-self: flex-start;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 7px;
		padding: 0.35rem 0.5rem;
		margin-bottom: 0.6rem;
		color: var(--accent-soft);
		font-size: 0.78rem;
		cursor: pointer;
	}
	.guide:hover {
		border-color: var(--color-brand);
	}
</style>
