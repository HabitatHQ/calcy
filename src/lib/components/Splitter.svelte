<script lang="ts">
// Vertical column splitter: drag horizontally to resize, or click a chevron
// to fully collapse/expand the adjacent column. Uses pointer events so the
// same drag handler covers mouse and touch.
//
// `min` is the px floor for the column on the LEFT side of the splitter when
// expanded. `leftCollapsed` and `rightCollapsed` are read-only reflections
// of the parent's collapse state for the two adjacent columns; the parent
// owns the truth and toggles via the chevron callbacks.
//
// Two chevrons are always present (one per adjacent column) but only render
// on hover/focus/collapse to avoid cluttering the resting state. The left
// chevron points left (toward the left column) and collapses it; the right
// chevron points right and collapses the right column.
let {
	min = 200,
	leftCollapsed = false,
	rightCollapsed = false,
	collapsible = true,
	onresize,
	onresizeend,
	onlefttoggle,
	onrighttoggle
}: {
	min?: number;
	leftCollapsed?: boolean;
	rightCollapsed?: boolean;
	collapsible?: boolean;
	onresize: (deltaPx: number) => void;
	// Fired once a resize gesture commits (pointer release or keyboard step) so
	// the parent can persist. A drag calls preventDefault on pointerdown, which
	// suppresses the compatibility mouseup — so a document-level mouseup listener
	// would never see a drag end. This explicit callback is the reliable signal.
	onresizeend?: () => void;
	onlefttoggle?: () => void;
	onrighttoggle?: () => void;
} = $props();

// The chevrons sit on top of the splitter, so we can't let them swallow the
// drag. Instead every press starts a potential drag; we distinguish a *click*
// (no movement → toggle the adjacent column) from a *drag* (moved past the
// threshold → resize). This keeps the whole splitter draggable, chevrons and
// all, while a tap on a chevron still collapses/expands.
const DRAG_THRESHOLD = 3; // px before a press counts as a drag, not a click

let dragging = $state(false);
let moved = false;
let downX = 0;
let lastX = 0;
let pendingToggle: (() => void) | undefined;

function onPointerDown(e: PointerEvent) {
	const chevron = (e.target as HTMLElement).closest('.chevron');
	pendingToggle = chevron
		? chevron.classList.contains('left')
			? onlefttoggle
			: onrighttoggle
		: undefined;
	dragging = true;
	moved = false;
	downX = lastX = e.clientX;
	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	e.preventDefault();
}
function onPointerMove(e: PointerEvent) {
	if (!dragging) return;
	if (Math.abs(e.clientX - downX) > DRAG_THRESHOLD) moved = true;
	const dx = e.clientX - lastX;
	lastX = e.clientX;
	if (moved) onresize(dx);
}
function onPointerUp(e: PointerEvent) {
	if (!dragging) return;
	dragging = false;
	(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
	if (moved) onresizeend?.();
	else pendingToggle?.(); // a press that didn't move is a click on a chevron
	pendingToggle = undefined;
}
function onPointerCancel(e: PointerEvent) {
	if (!dragging) return;
	dragging = false;
	(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
	pendingToggle = undefined; // cancelled gesture: neither resize nor toggle
}
function onKey(e: KeyboardEvent) {
	const step = e.shiftKey ? 32 : 8;
	if (e.key === 'ArrowLeft') {
		e.preventDefault();
		onresize(-step);
		onresizeend?.();
	} else if (e.key === 'ArrowRight') {
		e.preventDefault();
		onresize(step);
		onresizeend?.();
	}
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="splitter"
	class:active={dragging}
	class:any-collapsed={leftCollapsed || rightCollapsed}
	role="separator"
	aria-orientation="vertical"
	tabindex="0"
	aria-label="resize column"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerCancel}
	onkeydown={onKey}
>
	{#if collapsible && onlefttoggle}
		<button
			type="button"
			class="chevron left"
			class:visible={leftCollapsed}
			aria-label={leftCollapsed ? 'expand left column' : 'collapse left column'}
			tabindex="-1"
		>‹</button>
	{/if}
	{#if collapsible && onrighttoggle}
		<button
			type="button"
			class="chevron right"
			class:visible={rightCollapsed}
			aria-label={rightCollapsed ? 'expand right column' : 'collapse right column'}
			tabindex="-1"
		>›</button>
	{/if}
</div>

<style>
	.splitter {
		cursor: col-resize;
		background: transparent;
		position: relative;
		touch-action: none;
		/* Wider hit target than visual line; the centre 1px gets the visible
		   border, the rest is invisible padding for the cursor. Kept generous so
		   the resize handle and its chevrons are easy to land on with a mouse. */
		width: 14px;
		flex-shrink: 0;
	}
	.splitter::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 50%;
		transform: translateX(-50%);
		width: 1px;
		background: var(--border);
		transition: background 0.15s;
	}
	.splitter:hover::before,
	.splitter.active::before {
		background: var(--color-brand);
	}
	.splitter:focus-visible {
		outline: none;
	}
	.splitter:focus-visible::before {
		background: var(--color-brand);
		box-shadow: 0 0 0 2px var(--color-brand);
	}
	/* Two chevrons pinned to the middle of the splitter, one per side. They
	   fade in on hover/focus or stay visible when their adjacent column is
	   collapsed (so the user can re-expand). */
	.chevron {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		width: 14px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		background: var(--surface-1);
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1;
		cursor: pointer;
		opacity: 0;
		/* Hidden chevrons must not swallow clicks: when a column collapses to
		   zero width its two flanking splitters become adjacent, so an
		   invisible chevron from the neighbouring splitter can otherwise sit
		   over the visible re-expand chevron. Re-enabled with opacity below. */
		pointer-events: none;
		transition: opacity 0.15s;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1;
	}
	/* Both chevrons centre on the same 6px-wide line, so they're stacked
	   vertically (left above centre, right below) instead of overlapping —
	   otherwise the later-in-DOM right chevron would intercept clicks meant
	   for the left one. */
	.chevron.left {
		left: 50%;
		top: calc(50% - 16px);
		transform: translate(-50%, -50%);
	}
	.chevron.right {
		left: 50%;
		top: calc(50% + 16px);
		transform: translate(-50%, -50%);
	}
	/* Discoverable at rest: show both chevrons faintly so it's obvious the
	   columns can be collapsed, then brighten on hover/focus. Suppressed while a
	   neighbour is collapsed (.any-collapsed) so the resting chevrons can't sit
	   over — and swallow clicks meant for — an adjacent splitter's re-expand
	   chevron; only the explicit `.visible` ones show in that state. */
	.splitter:not(.any-collapsed) .chevron {
		opacity: 0.4;
		pointer-events: auto;
	}
	.splitter:hover .chevron,
	.splitter:focus-within .chevron,
	.chevron.visible {
		opacity: 1;
		pointer-events: auto;
	}
	.chevron:hover {
		color: var(--text);
		border-color: var(--color-brand);
	}
</style>