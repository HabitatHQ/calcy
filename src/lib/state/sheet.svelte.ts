// SheetController — the imperative shell.
//
// Owns the app's reactive document/engine/db state and all the I/O-bearing
// orchestration (debounced eval, autosave, sheet CRUD, export/import, share,
// clipboard, custom units, history, panel visibility). It delegates every pure
// decision to the tested functional core under `$lib/sheet/*`; the methods here
// are deliberately the untestable, side-effecting glue.
//
// Instantiate during component init (so the constructor's `$effect`s bind to
// the component lifecycle), then call `boot()` from onMount to spin up the
// workers and load persisted state.

import { DbClient, type RevisionItem, type SheetListItem } from '$lib/db/client';
import { setLineConversion } from '$lib/editor';
import type { LineResult, NumberFormat, RatePeriod } from '$lib/engine';
import { EngineClient } from '$lib/engine/client';
import { decodeShare, encodeShare } from '$lib/share';
import { annotatedBody, slugify, toCsv, toMarkdown } from '$lib/sheet/export';
import { parseCustomUnitInput, parseSettings } from '$lib/sheet/settings';
import type { Template } from '$lib/templates';

const SAMPLE = `# capacity
rate = 12_000 req/s
rate in req/day
rate * 30 day

# uncertain rate + accumulation
load = (800 to 1200) req/s
load * 1 month

# storage accrual
write = (2 to 5) MB/s
write * 1 day in TB

# correlation via reuse
x = 1 to 10
x - x`;

// Layout constants used by the column-toggle actions. Match the page's
// MIN_*_EDITOR / MIN_*_GUTTER / MIN_INSPECTOR and the default widths above.
const MIN_LAYOUT_EDITOR = 240;
const MIN_LAYOUT_GUTTER = 160;
const MIN_LAYOUT_INSPECTOR = 280;
const DEFAULT_LAYOUT_EDITOR = 420;
const DEFAULT_LAYOUT_GUTTER = 280;
const DEFAULT_LAYOUT_INSPECTOR = 360;

export class SheetController {
	// --- document state ---
	body = $state(SAMPLE);
	title = $state('Untitled');
	sheetId = $state<string>(crypto.randomUUID());
	seed = $state(0x9e3779b9);

	results = $state<LineResult[]>([]);
	selected = $state(0);
	unitNames = $state<string[]>([]);

	// --- settings ---
	monthDays = $state(30.436875);
	yearDays = $state(365.25);
	samples = $state(10000);
	numberFormat = $state<NumberFormat>('auto');
	confidence = $state(0.9);
	debugAst = $state(false);
	mode = $state<'notepad' | 'tape'>('notepad');
	// Three-pane column widths in pixels. The page hydrates these on boot from
	// the persisted layout setting; we hold the live values here so the page
	// can re-render mid-drag without round-tripping to the DB. Defaults fit a
	// ~1024px viewport with the inspector still readable; the page clamps
	// during drag so they always sum to fit the window.
	editorWidth = $state(420);
	gutterWidth = $state(280);
	inspectorWidth = $state(360);
	// Collapse flags for each column. A collapsed column renders at 0 width;
	// its splitter chevron flips to point outward and dragging it re-expands
	// to the column's pre-collapse `editorWidth / gutterWidth / inspectorWidth`.
	editorCollapsed = $state(false);
	gutterCollapsed = $state(false);
	inspectorCollapsed = $state(false);

	// --- custom units ---
	customUnits = $state<Record<string, string>>({});
	newUnit = $state('');
	unitError = $state('');

	// --- panels / browse / history ---
	showSheets = $state(false);
	showSettings = $state(false);
	showHelp = $state(false);
	showHistory = $state(false);
	showTemplates = $state(false);
	// Long-form docs, shown as full-screen reader overlays.
	showGuide = $state(false);
	showHowItWorks = $state(false);
	sheetsList = $state<SheetListItem[]>([]);
	revisions = $state<RevisionItem[]>([]);
	searchQuery = $state('');

	// --- transient action feedback ---
	copied = $state(false);
	shared = $state(false);
	lineCopied = $state(false);
	rerolled = $state(false);
	pinUnitInput = $state('');

	// --- engine / db lifecycle ---
	evalError = $state('');
	evalTick = $state(0);
	// true when this tab fell back to an in-memory DB (calcy is open in another
	// tab that owns the on-disk database) — surfaced so edits aren't lost.
	ephemeral = $state(false);

	engine = $state<EngineClient>();
	private db: DbClient | undefined;

	private evalTimer: ReturnType<typeof setTimeout> | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	// --- derived views ---
	selectedLine = $derived(this.results.find((l) => l.index === this.selected));
	seedHex = $derived(`0x${(this.seed >>> 0).toString(16)}`);
	slug = $derived(slugify(this.title));

	constructor() {
		// Live evaluation, debounced ~120 ms.
		$effect(() => {
			void this.body;
			void this.seed;
			void this.samples;
			void this.monthDays;
			void this.yearDays;
			void this.numberFormat;
			void this.confidence;
			void this.customUnits;
			clearTimeout(this.evalTimer);
			this.evalTimer = setTimeout(() => this.runEval(), 120);
		});
		// Autosave the sheet text + seed, debounced.
		$effect(() => {
			void this.body;
			void this.title;
			void this.seed;
			if (!this.db) return;
			clearTimeout(this.saveTimer);
			this.saveTimer = setTimeout(() => {
				this.db?.save({ id: this.sheetId, title: this.title, body: this.body, seed: this.seed });
			}, 700);
		});
		// Reset the pin input when the cursor moves to another line.
		$effect(() => {
			void this.selected;
			this.pinUnitInput = '';
		});
	}

	// Spin up the workers and load persisted/shared state. Browser-only.
	async boot() {
		this.engine = new EngineClient();
		this.db = new DbClient();
		this.engine.unitNames().then((n) => (this.unitNames = n));
		await this.db.ready;
		this.ephemeral = !this.db.persistent;
		const settings = parseSettings(await this.db.getSettings());
		if (settings.monthDays !== undefined) this.monthDays = settings.monthDays;
		if (settings.yearDays !== undefined) this.yearDays = settings.yearDays;
		if (settings.samples !== undefined) this.samples = settings.samples;
		if (settings.numberFormat) this.numberFormat = settings.numberFormat;
		if (settings.confidence !== undefined) this.confidence = settings.confidence;
		if (settings.mode) this.mode = settings.mode;
		if (settings.layout) {
			this.editorWidth = settings.layout.editor;
			this.gutterWidth = settings.layout.gutter;
			this.inspectorWidth = settings.layout.inspector;
			this.editorCollapsed = settings.layout.editorCollapsed;
			this.gutterCollapsed = settings.layout.gutterCollapsed;
			this.inspectorCollapsed = settings.layout.inspectorCollapsed;
		}
		this.debugAst = settings.debugAst;
		this.customUnits = await this.db.customUnits();
		// A shared sheet in the URL fragment takes precedence over the last sheet.
		const shared = location.hash.length > 1 ? decodeShare(location.hash.slice(1)) : null;
		if (shared) {
			this.sheetId = crypto.randomUUID();
			this.title = shared.title;
			this.body = shared.body;
			this.seed = shared.seed;
			await this.db.save({ id: this.sheetId, title: this.title, body: this.body, seed: this.seed });
			history.replaceState(null, '', location.pathname + location.search);
		} else {
			const last = await this.db.loadLast();
			if (last) this.adopt(last);
		}
		await this.refreshSheets();
		this.runEval();
	}

	destroy() {
		this.engine?.destroy();
	}

	// Copy a loaded sheet row into the live document fields.
	private adopt(row: { id: string; title: string; body: string; seed: number }) {
		this.sheetId = row.id;
		this.title = row.title;
		this.body = row.body;
		this.seed = row.seed;
	}

	async runEval() {
		if (!this.engine) return;
		try {
			this.results = (
				await this.engine.evalSheet(
					this.body,
					{
						seed: this.seed,
						N: this.samples,
						monthDays: this.monthDays,
						yearDays: this.yearDays,
						numberFormat: this.numberFormat,
						confidence: this.confidence
					},
					this.customUnits
				)
			).lines;
			this.evalTick++;
			this.evalError = '';
		} catch (e) {
			// A broken custom unit can fail engine construction for the whole sheet.
			this.evalError = e instanceof Error ? e.message : String(e);
		}
	}

	accumulate = (index: number, period: RatePeriod, count: number, growth = 0) =>
		this.engine ? this.engine.accumulate(index, period, count, growth) : Promise.resolve(null);

	select(index: number) {
		this.selected = index;
	}

	// --- sheet CRUD -----------------------------------------------------------
	async refreshSheets() {
		if (!this.db) return;
		this.sheetsList = this.searchQuery.trim()
			? await this.db.search(this.searchQuery)
			: await this.db.list();
	}

	async newSheet() {
		if (!this.db) return;
		await this.db.snapshot(this.sheetId, this.body); // snapshot before leaving
		this.sheetId = crypto.randomUUID();
		this.title = 'Untitled';
		this.body = '';
		this.seed = (Math.random() * 2 ** 31) | 0;
		await this.db.save({ id: this.sheetId, title: this.title, body: this.body, seed: this.seed });
		await this.refreshSheets();
	}

	async openSheet(id: string) {
		if (!this.db) return;
		if (id === this.sheetId) {
			this.showSheets = false;
			return;
		}
		await this.db.snapshot(this.sheetId, this.body);
		const data = await this.db.loadSheet(id);
		if (data) this.adopt(data);
		this.showSheets = false;
	}

	async deleteSheet(id: string) {
		if (!this.db) return;
		if (!confirm('Delete this sheet? This cannot be undone.')) return;
		await this.db.delete(id);
		if (id === this.sheetId) {
			const last = await this.db.loadLast();
			if (last) this.adopt(last);
			else {
				this.sheetId = crypto.randomUUID();
				this.title = 'Untitled';
				this.body = '';
			}
		}
		await this.refreshSheets();
	}

	async renameSheet(id: string) {
		if (!this.db) return;
		const cur = this.sheetsList.find((s) => s.id === id)?.title ?? '';
		const name = prompt('Rename sheet', cur);
		if (name == null) return;
		if (id === this.sheetId) {
			this.title = name;
			await this.db.save({ id, title: name, body: this.body, seed: this.seed });
		} else {
			const row = await this.db.loadSheet(id);
			if (row) await this.db.save({ ...row, title: name });
		}
		await this.refreshSheets();
	}

	async duplicateSheet(id: string) {
		if (!this.db) return;
		const row =
			id === this.sheetId
				? { id, title: this.title, body: this.body, seed: this.seed }
				: await this.db.loadSheet(id);
		if (!row) return;
		await this.db.save({
			id: crypto.randomUUID(),
			title: `${row.title} copy`,
			body: row.body,
			seed: row.seed
		});
		await this.refreshSheets();
	}

	reroll() {
		this.seed = (Math.random() * 2 ** 31) | 0;
		this.rerolled = true;
		setTimeout(() => (this.rerolled = false), 450);
	}

	// --- templates ------------------------------------------------------------
	loadTemplate(t: Template) {
		this.title = t.title;
		this.body = t.body;
		this.selected = 0;
	}

	// Load into the current sheet if it's blank, otherwise start a fresh sheet
	// so existing work is never clobbered.
	async newFromTemplate(t: Template) {
		this.showTemplates = false;
		if (this.body.trim() === '' || !this.db) {
			this.loadTemplate(t);
			return;
		}
		await this.db.snapshot(this.sheetId, this.body);
		this.sheetId = crypto.randomUUID();
		this.title = t.title;
		this.body = t.body;
		this.seed = (Math.random() * 2 ** 31) | 0;
		this.selected = 0;
		await this.db.save({ id: this.sheetId, title: this.title, body: this.body, seed: this.seed });
		await this.refreshSheets();
	}

	// --- custom units ---------------------------------------------------------
	async applyCustomUnit() {
		const parsed = parseCustomUnitInput(this.newUnit);
		if ('error' in parsed) {
			this.unitError = parsed.error;
			return;
		}
		const trial = { ...this.customUnits, [parsed.name]: parsed.definition };
		try {
			// Validate by building an engine with the unit and using it once.
			await this.engine?.evalSheet(
				`1 ${parsed.name}`,
				{ monthDays: this.monthDays, yearDays: this.yearDays },
				trial
			);
		} catch (e) {
			this.unitError = `invalid: ${e instanceof Error ? e.message : String(e)}`;
			return;
		}
		this.customUnits = trial;
		this.db?.setCustomUnit(parsed.name, parsed.definition);
		this.newUnit = '';
		this.unitError = '';
		this.engine?.unitNames().then((n) => (this.unitNames = n));
	}

	removeCustomUnit(name: string) {
		const { [name]: _drop, ...rest } = this.customUnits;
		this.customUnits = rest;
		this.db?.deleteCustomUnit(name);
	}

	// --- revision history -----------------------------------------------------
	async openHistory() {
		this.showHistory = !this.showHistory;
		if (this.showHistory && this.db) this.revisions = await this.db.listRevisions(this.sheetId);
	}

	async snapshotNow() {
		if (!this.db) return;
		await this.db.snapshot(this.sheetId, this.body);
		this.revisions = await this.db.listRevisions(this.sheetId);
	}

	async restoreRevision(id: number) {
		if (!this.db) return;
		await this.db.snapshot(this.sheetId, this.body); // checkpoint current first
		const r = await this.db.loadRevision(id);
		if (r) this.body = r.body;
		this.showHistory = false;
	}

	// --- editor bridges -------------------------------------------------------
	// Append a snippet on its own line (used as the Notepad fallback for Help).
	appendLine(snippet: string) {
		this.body = this.body.trim() ? `${this.body}\n${snippet}` : snippet;
	}

	// Tape "send to sheet": append or replace the whole body.
	applyTapeExpr(expr: string, append: boolean) {
		this.body = append ? `${this.body}\n${expr}` : expr;
	}

	// Pin the selected line's output unit by rewriting its source line.
	pinLine() {
		const arr = this.body.split('\n');
		if (this.selected < 0 || this.selected >= arr.length) return;
		arr[this.selected] = setLineConversion(arr[this.selected], this.pinUnitInput);
		this.body = arr.join('\n');
	}

	// --- clipboard / share ----------------------------------------------------
	async copySheet() {
		await navigator.clipboard.writeText(annotatedBody(this.body, this.results));
		this.copied = true;
		setTimeout(() => (this.copied = false), 1200);
	}

	// A shareable URL with the whole sheet packed into the hash. Pure read of the
	// current sheet + location; safe to call from any view (e.g. the bug report).
	shareUrl(): string {
		return `${location.origin}${location.pathname}#${encodeShare({ title: this.title, body: this.body, seed: this.seed })}`;
	}

	async shareLink() {
		const url = this.shareUrl();
		await navigator.clipboard.writeText(url);
		this.shared = true;
		setTimeout(() => (this.shared = false), 1400);
	}

	async copyLine() {
		const t = this.selectedLine?.display?.text;
		if (!t) return;
		await navigator.clipboard.writeText(t);
		this.lineCopied = true;
		setTimeout(() => (this.lineCopied = false), 1200);
	}

	// Copy a specific line (used by the gutter's per-row copy button, which
	// can't rely on the cursor position). Mirrors copyLine() exactly.
	async copyLineAt(index: number) {
		const line = this.results.find((l) => l.index === index);
		const t = line?.display?.text;
		if (!t) return;
		await navigator.clipboard.writeText(t);
		this.lineCopied = true;
		setTimeout(() => (this.lineCopied = false), 1200);
	}

	// --- export / import ------------------------------------------------------
	private download(name: string, content: BlobPart, type: string) {
		const blob = new Blob([content], { type });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
	}

	exportTxt() {
		this.download(`${this.slug}.txt`, annotatedBody(this.body, this.results), 'text/plain');
	}

	exportMd() {
		const md = toMarkdown(this.title, annotatedBody(this.body, this.results));
		this.download(`${this.slug}.md`, md, 'text/markdown');
	}

	exportCsv() {
		this.download(`${this.slug}.csv`, toCsv(this.results), 'text/csv');
	}

	async exportDb() {
		if (!this.db) return;
		const bytes = await this.db.export();
		this.download('calcy.sqlite', bytes as BlobPart, 'application/x-sqlite3');
	}

	async importDb(file: File) {
		if (!this.db) return;
		const bytes = new Uint8Array(await file.arrayBuffer());
		await this.db.import(bytes);
		const last = await this.db.loadLast();
		if (last) this.adopt(last);
		await this.refreshSheets();
	}

	// --- settings persistence + panel toggles ---------------------------------
	persistSetting(key: string, value: string) {
		this.db?.setSetting(key, value);
	}

	setMode(mode: 'notepad' | 'tape') {
		this.mode = mode;
		this.persistSetting('mode', mode);
	}

	setNumberFormat(fmt: NumberFormat) {
		this.numberFormat = fmt;
		this.persistSetting('numberFormat', fmt);
	}

	setConfidence(c: number) {
		if (!(c > 0 && c < 1)) return;
		this.confidence = c;
		this.persistSetting('confidence', String(c));
	}

	// Persist all three column widths + collapse flags at once. The page
	// calls this on drag-end (not every move) to avoid spamming the DB
	// during a single drag gesture.
	setLayout(editor: number, gutter: number, inspector: number) {
		this.editorWidth = editor;
		this.gutterWidth = gutter;
		this.inspectorWidth = inspector;
		this.persistSetting(
			'layout',
			`${editor},${gutter},${inspector},${this.editorCollapsed ? 1 : 0},${this.gutterCollapsed ? 1 : 0},${this.inspectorCollapsed ? 1 : 0}`
		);
	}

	toggleEditor() {
		this.editorCollapsed = !this.editorCollapsed;
		if (!this.editorCollapsed && this.editorWidth < MIN_LAYOUT_EDITOR) {
			this.editorWidth = DEFAULT_LAYOUT_EDITOR;
		}
		this.persistSetting(
			'layout',
			`${this.editorWidth},${this.gutterWidth},${this.inspectorWidth},${this.editorCollapsed ? 1 : 0},${this.gutterCollapsed ? 1 : 0},${this.inspectorCollapsed ? 1 : 0}`
		);
	}
	toggleGutter() {
		this.gutterCollapsed = !this.gutterCollapsed;
		if (!this.gutterCollapsed && this.gutterWidth < MIN_LAYOUT_GUTTER) {
			this.gutterWidth = DEFAULT_LAYOUT_GUTTER;
		}
		this.persistSetting(
			'layout',
			`${this.editorWidth},${this.gutterWidth},${this.inspectorWidth},${this.editorCollapsed ? 1 : 0},${this.gutterCollapsed ? 1 : 0},${this.inspectorCollapsed ? 1 : 0}`
		);
	}
	toggleInspector() {
		this.inspectorCollapsed = !this.inspectorCollapsed;
		if (!this.inspectorCollapsed && this.inspectorWidth < MIN_LAYOUT_INSPECTOR) {
			this.inspectorWidth = DEFAULT_LAYOUT_INSPECTOR;
		}
		this.persistSetting(
			'layout',
			`${this.editorWidth},${this.gutterWidth},${this.inspectorWidth},${this.editorCollapsed ? 1 : 0},${this.gutterCollapsed ? 1 : 0},${this.inspectorCollapsed ? 1 : 0}`
		);
	}

	toggleDebug() {
		this.debugAst = !this.debugAst;
		this.persistSetting('debugAst', String(this.debugAst));
	}

	toggleSettings() {
		this.showSettings = !this.showSettings;
	}

	toggleHelp() {
		this.showHelp = !this.showHelp;
	}

	toggleTemplates() {
		this.showTemplates = !this.showTemplates;
	}

	// Docs are mutually exclusive with each other (one reader at a time).
	openGuide() {
		this.showHowItWorks = false;
		this.showGuide = true;
	}

	openHowItWorks() {
		this.showGuide = false;
		this.showHowItWorks = true;
	}

	async toggleSheets() {
		this.showSheets = !this.showSheets;
		if (this.showSheets) await this.refreshSheets();
	}

	closeOverlays() {
		this.showSheets = false;
		this.showHelp = false;
		this.showSettings = false;
		this.showHistory = false;
		this.showTemplates = false;
		this.showGuide = false;
		this.showHowItWorks = false;
	}
}
