<script module lang="ts">
import { defineMeta } from '@storybook/addon-svelte-csf';
import Menu from './Menu.svelte';

// Menu is the header's dropdown chrome: a trigger plus an accessible popup of
// `role="menuitem"` rows. Open it in the canvas to see item styling, separators
// and trailing hints.
const { Story } = defineMeta({
	title: 'Calcy/Menu',
	component: Menu,
	tags: ['autodocs'],
	args: { label: 'Copy', title: 'Copy & export' }
});
</script>

<Story name="Copy & export">
	{#snippet template(args)}
		<Menu label={args.label} title={args.title} align={args.align} active={args.active}>
			{#snippet children({ close })}
				<button role="menuitem" onclick={close}>Copy sheet + results</button>
				<button role="menuitem" onclick={close}>Copy share link</button>
				<div role="separator"></div>
				<button role="menuitem" onclick={close}>Download<span class="hint">.txt</span></button>
				<button role="menuitem" onclick={close}>Download<span class="hint">.md</span></button>
				<button role="menuitem" onclick={close}>Download<span class="hint">.csv</span></button>
			{/snippet}
		</Menu>
	{/snippet}
</Story>

<Story name="Sheets (right-aligned)" args={{ label: 'Sheets', title: 'Sheets', align: 'right' }}>
	{#snippet template(args)}
		<div style="display: flex; justify-content: flex-end;">
			<Menu label={args.label} title={args.title} align={args.align}>
				{#snippet children({ close })}
					<button role="menuitem" onclick={close}>New sheet</button>
					<div role="separator"></div>
					<button role="menuitem" onclick={close}>Start from an example…</button>
					<button role="menuitem" onclick={close}>Browse sheets…<span class="hint">⌘K</span></button>
					<button role="menuitem" onclick={close}>Revision history…</button>
				{/snippet}
			</Menu>
		</div>
	{/snippet}
</Story>
