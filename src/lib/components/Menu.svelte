<script lang="ts">
// Presentation-only: an accessible dropdown menu. Owns just the trigger button
// and the popup's open/close + keyboard behaviour; the menu items are supplied
// by the parent as a snippet, so each item forwards whatever controller intent
// it likes.
//
// Items are plain `<button role="menuitem">`s; separators are any
// `[role="separator"]`. The component styles both via :global so callers write
// minimal markup. The snippet receives `close` so an item can dismiss the menu
// after acting.
import type { Snippet } from 'svelte';

let {
	label,
	title,
	align = 'left',
	active = false,
	children
}: {
	label: string;
	title?: string;
	// Which edge of the trigger the popup aligns to.
	align?: 'left' | 'right';
	// Tint the trigger as active even when closed (caller-driven state).
	active?: boolean;
	children: Snippet<[{ close: () => void }]>;
} = $props();

let open = $state(false);
let wrap = $state<HTMLElement>();
let trigger = $state<HTMLButtonElement>();
let menuEl = $state<HTMLElement>();

function close() {
	open = false;
}

// On open, move focus to the first item so arrow-key navigation has an anchor
// and the menu is immediately keyboard-operable.
$effect(() => {
	if (open && menuEl) {
		menuEl.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
	}
});

function items(): HTMLElement[] {
	return menuEl ? Array.from(menuEl.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
}

// Click anywhere outside the trigger+popup dismisses the menu.
function onWindowPointerDown(e: PointerEvent) {
	if (open && wrap && !wrap.contains(e.target as Node)) close();
}

function onTriggerKeydown(e: KeyboardEvent) {
	if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
		e.preventDefault();
		open = true;
	}
}

function onMenuKeydown(e: KeyboardEvent) {
	const list = items();
	if (!list.length) return;
	const i = list.indexOf(document.activeElement as HTMLElement);
	switch (e.key) {
		case 'ArrowDown':
			e.preventDefault();
			list[(i + 1) % list.length].focus();
			break;
		case 'ArrowUp':
			e.preventDefault();
			list[(i - 1 + list.length) % list.length].focus();
			break;
		case 'Home':
			e.preventDefault();
			list[0].focus();
			break;
		case 'End':
			e.preventDefault();
			list[list.length - 1].focus();
			break;
		case 'Escape':
			e.preventDefault();
			close();
			trigger?.focus();
			break;
		case 'Tab':
			// Let focus leave naturally, but don't leave a detached popup behind.
			close();
			break;
	}
}
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="menu-wrap" bind:this={wrap}>
	<button
		bind:this={trigger}
		type="button"
		class="trigger"
		class:active={active || open}
		aria-haspopup="menu"
		aria-expanded={open}
		{title}
		onclick={() => (open = !open)}
		onkeydown={onTriggerKeydown}
	>
		{label}<span class="caret" aria-hidden="true">▾</span>
	</button>

	{#if open}
		<div
			class="menu"
			class:right={align === 'right'}
			role="menu"
			tabindex="-1"
			aria-label={title ?? label}
			bind:this={menuEl}
			onkeydown={onMenuKeydown}
		>
			{@render children({ close })}
		</div>
	{/if}
</div>

<style>
	.menu-wrap {
		position: relative;
		display: inline-flex;
	}
	/* Match the surrounding header buttons (tokens keep them in lockstep). */
	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-2);
		padding: 0.3rem 0.6rem;
		border-radius: 7px;
		cursor: pointer;
		font-size: 0.85rem;
		font-family: inherit;
	}
	.trigger:hover {
		border-color: var(--color-brand);
	}
	.trigger.active {
		border-color: var(--color-brand);
		color: var(--text);
		background: var(--surface-accent);
	}
	.caret {
		font-size: 0.7rem;
		opacity: 0.8;
	}
	.menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		min-width: 12rem;
		display: flex;
		flex-direction: column;
		padding: 0.3rem;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 12px 40px var(--shadow);
		z-index: 25;
	}
	.menu.right {
		left: auto;
		right: 0;
	}
	/* Items are supplied by the parent snippet, so reach them with :global. */
	.menu :global(button[role='menuitem']) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		color: var(--text-2);
		padding: 0.4rem 0.55rem;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
		font-family: inherit;
	}
	.menu :global(button[role='menuitem']:hover),
	.menu :global(button[role='menuitem']:focus-visible) {
		background: var(--surface-accent);
		color: var(--text);
		outline: none;
	}
	/* A trailing hint (shortcut / file ext) sits muted at the row's end. */
	.menu :global(button[role='menuitem'] .hint) {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.72rem;
	}
	.menu :global([role='separator']) {
		height: 1px;
		margin: 0.3rem 0.2rem;
		background: var(--border);
	}
</style>
