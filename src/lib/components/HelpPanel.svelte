<script lang="ts">
// Cheat-sheet of the expression language (US-1). Each example is click-to-insert
// so users learn the syntax by dropping working lines into their sheet. The
// examples live in $lib/cheatsheet so a doctest can prove they all evaluate.
import { CHEAT_SHEET } from '$lib/cheatsheet';
let {
	oninsert,
	onguide,
	onexamples,
	onreference,
	onhowitworks,
	onclose,
	topic
}: {
	oninsert: (snippet: string) => void;
	onguide: () => void;
	onexamples: () => void;
	onreference: () => void;
	onhowitworks: () => void;
	onclose: () => void;
	// When opened from an errored line, the group title to scroll to + highlight.
	topic?: string;
} = $props();

const GROUPS = CHEAT_SHEET;

// When the panel is opened against a topic, bring that group into view and
// flag it so the highlight draws the eye. Re-runs if the topic changes while
// the panel stays open (e.g. a second error of a different kind).
let groupsEl = $state<HTMLElement>();
$effect(() => {
	if (!topic || !groupsEl) return;
	const el = groupsEl.querySelector<HTMLElement>(`[data-topic="${CSS.escape(topic)}"]`);
	el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
});
</script>

<aside class="help" aria-label="syntax cheat sheet">
	<header>
		<h3>Cheat sheet</h3>
		<button class="x" onclick={onclose} aria-label="close help">✕</button>
	</header>
	<section class="goals" aria-label="modelling goals">
		<h4>What do you want to explore?</h4>
		<ul>
			<li><strong>Compare labelled alternatives:</strong> use scenarios for named cases, not probabilities.</li>
			<li><strong>Condition on evidence:</strong> <code>given</code> filters matching draws and resamples them; original variables stay unchanged.</li>
			<li><strong>Inspect uncertainty drivers:</strong> select a sampled result for squared-correlation scores—not causal or additive shares.</li>
			<li><strong>Reproduce sampled results:</strong> keep the same source, seed and settings for repeatable draws.</li>
		</ul>
		<div class="goal-actions">
			<button class="goal-action" onclick={onguide}>Read the Guide</button>
			<button class="goal-action" onclick={onexamples}>Open worked examples</button>
		</div>
	</section>
	<p class="hint">Click any example to drop it into your sheet.</p>
	<div class="groups" bind:this={groupsEl}>
		{#each GROUPS as g (g.title)}
			<section data-topic={g.title} class:focus={g.title === topic}>
				<h4>{g.title}</h4>
				{#each g.items as it (it.code)}
					<button class="ex" onclick={() => oninsert(it.code)} title="insert">
						<code>{it.code}</code>
						<span class="note">{it.note}</span>
					</button>
				{/each}
			</section>
		{/each}
	</div>
	<section class="shortcuts">
		<h4>Shortcuts</h4>
		<div class="keys">
			<span><kbd>⌘</kbd><kbd>K</kbd> sheets</span>
			<span><kbd>⌘</kbd><kbd>/</kbd> this help</span>
			<span><kbd>⌘</kbd><kbd>D</kbd> show AST</span>
			<span><kbd>⌘</kbd><kbd>↵</kbd> re-roll</span>
			<span><kbd>Esc</kbd> close</span>
		</div>
		<p class="hint">In the editor:</p>
		<div class="keys">
			<span><kbd>⌘</kbd><kbd>⇧</kbd><kbd>/</kbd> toggle comment</span>
			<span><kbd>⌥</kbd><kbd>↑</kbd>/<kbd>↓</kbd> move line</span>
			<span><kbd>⇧</kbd><kbd>⌥</kbd><kbd>↓</kbd> duplicate line</span>
		</div>
	</section>
	<p class="foot">
		A distribution shows its median and confidence interval (5th–95th percentile at 90% by
		default). The median is not necessarily the most common value. All computation is local—no
		network.
	</p>
	<nav class="docs" aria-label="documentation">
		<button class="doclink" onclick={onguide}>Read the Guide</button>
		<span aria-hidden="true">·</span>
		<button class="doclink" onclick={onreference}>Reference</button>
		<span aria-hidden="true">·</span>
		<button class="doclink" onclick={onhowitworks}>How it works</button>
	</nav>
</aside>

<style>
	.help {
		position: absolute;
		right: 0.75rem;
		top: 3.2rem;
		width: 380px;
		max-width: calc(100vw - 1.5rem);
		box-sizing: border-box;
		max-height: 78vh;
		overflow: auto;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.75rem 0.9rem;
		z-index: 30;
		box-shadow: 0 12px 40px var(--shadow);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	h3 {
		margin: 0;
		color: var(--accent-soft);
		font-size: 0.95rem;
	}
	.x {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.9rem;
	}
	.x:hover {
		color: var(--text);
	}
	.goals {
		margin: 0.7rem 0;
		padding-bottom: 0.7rem;
		border-bottom: 1px solid var(--border);
	}
	.goals ul {
		margin: 0.4rem 0 0.6rem;
		padding-left: 1.1rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		line-height: 1.45;
	}
	.goals li + li {
		margin-top: 0.3rem;
	}
	.goals strong {
		color: var(--text-2);
	}
	.goals code {
		font-family: var(--font-mono);
	}
	.goal-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.goal-action {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 7px;
		padding: 0.35rem 0.5rem;
		color: var(--accent-soft);
		font-size: 0.78rem;
		cursor: pointer;
	}
	.goal-action:hover {
		border-color: var(--color-brand);
	}
	.hint {
		margin: 0.3rem 0 0.6rem;
		color: var(--text-muted);
		font-size: 0.78rem;
	}
	.groups {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	/* The group an error pointed at: a soft outline + tint so the eye lands on
	   it after the scroll, without the jarring flash of an animation. */
	section.focus {
		border-radius: 8px;
		outline: 1px solid var(--border-accent);
		background: var(--surface-accent);
		padding: 0.3rem 0.4rem;
		margin: -0.3rem -0.4rem;
	}
	h4 {
		margin: 0 0 0.35rem;
		color: var(--c-rate);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 600;
	}
	.ex {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.6rem;
		width: 100%;
		text-align: left;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 7px;
		padding: 0.35rem 0.5rem;
		margin-bottom: 0.3rem;
		cursor: pointer;
	}
	.ex:hover {
		border-color: var(--color-brand);
		background: var(--surface-1);
	}
	.ex code {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--c-value-soft);
		/* Wrap long snippets (e.g. bracket(...)) instead of overflowing the panel.
		   pre-wrap keeps the snippet's own spacing; anywhere breaks an over-long
		   token so it can never push past the panel edge. min-width:0 lets the
		   flex item actually shrink below its content width. */
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		min-width: 0;
		flex: 1 1 auto;
	}
	.note {
		color: var(--text-muted);
		font-size: 0.7rem;
		flex: 0 1 auto;
		min-width: 0;
	}
	.shortcuts {
		margin-top: 0.85rem;
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
	}
	.keys {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.9rem;
		color: var(--text-muted);
		font-size: 0.74rem;
	}
	.keys kbd {
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		padding: 0 0.3rem;
		margin-right: 0.1rem;
		font-family: var(--font-mono);
		color: var(--text-2);
	}
	.foot {
		margin: 0.8rem 0 0;
		color: var(--text-faint);
		font-size: 0.72rem;
	}
	.docs {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
		color: var(--text-faint);
		font-size: 0.74rem;
	}
	.doclink {
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: var(--accent-soft);
		font-size: inherit;
	}
	.doclink:hover {
		color: var(--color-brand);
		text-decoration: underline;
	}
</style>
