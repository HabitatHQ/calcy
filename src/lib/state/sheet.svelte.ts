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

import { replaceState } from '$app/navigation';
import { DbClient, type RevisionItem, type SheetListItem } from '$lib/db/client';
import { setLineConversion } from '$lib/editor';
import type { LineResult, NumberFormat, RatePeriod } from '$lib/engine';
import { EngineClient } from '$lib/engine/client';
import { decodeShare, encodeShare } from '$lib/share';
import { buildExport, type CalcyExport, importSummary, validateImport } from '$lib/sheet/backup';
import { annotatedBody, slugify, toCsv, toMarkdown } from '$lib/sheet/export';
import { parseCustomUnitInput, parseSettings } from '$lib/sheet/settings';
import { STARTER_TEMPLATE, type Template } from '$lib/templates';

// Layout constants used by the column-toggle actions. Match the page's
// MIN_*_EDITOR / MIN_*_GUTTER / MIN_INSPECTOR and the default widths above.
const MIN_LAYOUT_EDITOR = 240;
const MIN_LAYOUT_GUTTER = 160;
const MIN_LAYOUT_INSPECTOR = 280;
const DEFAULT_LAYOUT_EDITOR = 420;
const DEFAULT_LAYOUT_GUTTER = 340;
const DEFAULT_LAYOUT_INSPECTOR = 360;

export class SheetController {
  // --- document state ---
  body = $state(STARTER_TEMPLATE.body);
  title = $state(STARTER_TEMPLATE.title);
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
  // UI colour theme. 'system' follows the OS/browser's prefers-color-scheme;
  // `systemDark` mirrors that media query live so `resolvedTheme` stays
  // correct if the user's OS theme flips while the app is open.
  theme = $state<'system' | 'light' | 'dark'>('system');
  systemDark = $state(true);
  private systemDarkQuery?: MediaQueryList;
  private onSystemDarkChange = (e: MediaQueryListEvent) => {
    this.systemDark = e.matches;
  };
  // Three-pane column widths in pixels. The page hydrates these on boot from
  // the persisted layout setting; we hold the live values here so the page
  // can re-render mid-drag without round-tripping to the DB. Defaults fit a
  // ~1024px viewport with the inspector still readable; the page clamps
  // during drag so they always sum to fit the window.
  editorWidth = $state(420);
  gutterWidth = $state(340);
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
  // When the help panel is opened from an error, the cheat-sheet group to
  // scroll to and highlight; undefined for a plain "open help".
  helpTopic = $state<string | undefined>(undefined);
  showHistory = $state(false);
  showTemplates = $state(false);
  // Long-form docs, shown as full-screen reader overlays.
  showGuide = $state(false);
  showReference = $state(false);
  showHowItWorks = $state(false);
  sheetsList = $state<SheetListItem[]>([]);
  revisions = $state<RevisionItem[]>([]);
  searchQuery = $state('');

  // --- transient action feedback ---
  copied = $state(false);
  shared = $state(false);
  // Result of the last backup/restore or destructive action, shown in the
  // settings Data section; `dataError` tints it as a failure.
  dataMessage = $state('');
  dataError = $state(false);
  lineCopied = $state(false);
  rerolled = $state(false);
  pinUnitInput = $state('');

  // --- engine / db lifecycle ---
  evalError = $state('');
  evalTick = $state(0);
  // true when this tab fell back to an in-memory DB (calcy is open in another
  // tab that owns the on-disk database) — surfaced so edits aren't lost.
  ephemeral = $state(false);
  // true when the most recent autosave write rejected (e.g. OPFS quota/disk
  // full). Surfaced so the user knows their edits aren't reaching disk instead
  // of typing on into a silent void.
  saveError = $state(false);

  engine = $state<EngineClient>();
  private db: DbClient | undefined;
  // Gates the autosave effect until boot() has loaded persisted state, so a
  // slow boot can't fire a debounced save of the constructor defaults (the
  // starter-template body under a throwaway id) before the real sheet is adopted.
  private booted = false;

  private evalTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  // --- derived views ---
  // True when the sheet has no source at all — the Notepad shows its onboarding
  // overlay in this state, so the gutter and grid suppress their own "nothing
  // here" hints to avoid three redundant empty messages across the panes.
  blank = $derived(this.body.trim() === '');
  selectedLine = $derived(this.results.find((l) => l.index === this.selected));
  seedHex = $derived(`0x${(this.seed >>> 0).toString(16)}`);
  slug = $derived(slugify(this.title));
  resolvedTheme = $derived<'light' | 'dark'>(
    this.theme === 'system' ? (this.systemDark ? 'dark' : 'light') : this.theme
  );
  isDark = $derived(this.resolvedTheme === 'dark');

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
      if (!this.db || !this.booted) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.persistSheet(), 700);
    });
    // Reset the pin input when the cursor moves to another line.
    $effect(() => {
      void this.selected;
      this.pinUnitInput = '';
    });
    // Reflect the resolved theme onto <html> so app.css's `html.light` /
    // `html.dark` blocks take effect. Runs on boot and on every change
    // (explicit pick or a live prefers-color-scheme flip).
    $effect(() => {
      const dark = this.resolvedTheme === 'dark';
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('light', !dark);
    });
  }

  // Spin up the workers and load persisted/shared state. Browser-only.
  async boot() {
    this.systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.systemDark = this.systemDarkQuery.matches;
    this.systemDarkQuery.addEventListener('change', this.onSystemDarkChange);
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
    if (settings.theme) this.theme = settings.theme;
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
      // Strip the share fragment via SvelteKit's router-aware replaceState so we
      // don't fight its history management (a raw history.replaceState warns).
      replaceState(location.pathname + location.search, {});
    } else {
      const last = await this.db.loadLast();
      if (last) this.adopt(last);
    }
    // Persisted state is now loaded; arm autosave for subsequent user edits.
    this.booted = true;
    await this.refreshSheets();
    this.runEval();
  }

  destroy() {
    this.engine?.destroy();
    this.systemDarkQuery?.removeEventListener('change', this.onSystemDarkChange);
  }

  // Copy a loaded sheet row into the live document fields.
  private adopt(row: { id: string; title: string; body: string; seed: number }) {
    this.sheetId = row.id;
    this.title = row.title;
    this.body = row.body;
    this.seed = row.seed;
  }

  // Persist the current sheet, tracking write failures. Used by the debounced
  // autosave; failures flip `saveError` so the view can warn the user.
  private persistSheet() {
    if (!this.db) return;
    this.db
      .save({ id: this.sheetId, title: this.title, body: this.body, seed: this.seed })
      .then(() => {
        this.saveError = false;
      })
      .catch(() => {
        this.saveError = true;
      });
  }

  // Force any pending debounced autosave to commit *now* and await it. Called
  // before switching sheet identity (new/open/template) so the current sheet's
  // last sub-debounce edits land in its row rather than surviving only as a
  // revision snapshot the user has to dig out of history.
  private async flushSave(): Promise<boolean> {
    if (!this.db) return false;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      await this.db.save({
        id: this.sheetId,
        title: this.title,
        body: this.body,
        seed: this.seed
      });
      this.saveError = false;
      return true;
    } catch {
      this.saveError = true;
      return false;
    }
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
    if (!(await this.flushSave())) return; // do not switch away after a failed save
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
    if (!(await this.flushSave())) return;
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
    if (!(await this.flushSave())) return;
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
    this.db?.setCustomUnit(parsed.name, parsed.definition).catch(() => {
      this.saveError = true;
    });
    this.newUnit = '';
    this.unitError = '';
    this.engine?.unitNames().then((n) => (this.unitNames = n));
  }

  removeCustomUnit(name: string) {
    const { [name]: _drop, ...rest } = this.customUnits;
    this.customUnits = rest;
    this.db?.deleteCustomUnit(name).catch(() => {
      this.saveError = true;
    });
  }

  // --- revision history -----------------------------------------------------
  async openHistory() {
    this.showHistory = !this.showHistory;
    this.showSettings = false;
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
    if (!(await this.flushSave())) {
      this.setDataMessage('Could not export: latest sheet edits could not be saved.', true);
      return;
    }
    try {
      const bytes = await this.db.export();
      this.download('calcy.sqlite', bytes as BlobPart, 'application/x-sqlite3');
    } catch (e) {
      this.setDataMessage(this.dataErrorText(e, 'Could not export.'), true);
    }
  }

  async importDb(file: File) {
    if (!this.db) return;
    try {
      // The import replaces the whole database, so don't let a late write inject
      // pre-import data after it.
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await this.db.import(bytes);
      const last = await this.db.loadLast();
      if (last) this.adopt(last);
      await this.refreshSheets();
    } catch (e) {
      this.setDataMessage(
        `Could not import that database: ${this.dataErrorText(e, 'database replacement failed')}`,
        true
      );
    }
  }

  // --- versioned JSON backup / restore + destructive ops --------------------
  async exportJson() {
    if (!this.db) return;
    try {
      if (!(await this.flushSave())) {
        this.setDataMessage('Could not export: latest sheet edits could not be saved.', true);
        return;
      }
      const doc = buildExport(await this.db.exportData(), new Date().toISOString());
      this.download('calcy-backup.json', JSON.stringify(doc, null, 2), 'application/json');
      this.setDataMessage(`Exported ${importSummary(doc)}.`);
    } catch (e) {
      this.setDataMessage(this.dataErrorText(e, 'Could not export.'), true);
    }
  }

  // Merge a JSON backup: existing sheets/units/settings are kept (the worker
  // does INSERT OR IGNORE), so re-importing never clobbers local work.
  async importJson(file: File) {
    if (!this.db) return;
    let doc: CalcyExport;
    try {
      doc = validateImport(JSON.parse(await file.text()));
    } catch (e) {
      this.setDataMessage(this.dataErrorText(e, 'Could not read that file.'), true);
      return;
    }
    try {
      await this.db.importData(doc);
      await this.reloadSettingsAndUnits();
      await this.refreshSheets();
      this.setDataMessage(`Imported ${importSummary(doc)} (existing data kept).`);
      this.runEval();
    } catch (e) {
      this.setDataMessage(this.dataErrorText(e, 'Could not import.'), true);
    }
  }

  // Danger zone: drop every sheet + revision, then start on a clean sheet.
  async clearAllSheets() {
    if (!this.db) return;
    if (
      !confirm(
        'Delete ALL sheets and their revision history? Custom units and settings are kept. This cannot be undone.'
      )
    )
      return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      await this.db.clearSheets();
      await this.startFreshSheet();
      await this.refreshSheets();
      this.setDataMessage('All sheets cleared.');
      this.runEval();
    } catch (e) {
      this.setDataMessage(this.dataErrorText(e, 'Could not clear sheets.'), true);
    }
  }

  // Danger zone: restore default settings and remove custom units; sheets kept.
  async resetUserData() {
    if (!this.db) return;
    if (
      !confirm('Reset all settings to defaults and remove every custom unit? Your sheets are kept.')
    )
      return;
    try {
      await this.db.resetUserData();
      this.applyDefaultSettings();
      this.customUnits = {};
      this.setDataMessage('Settings and custom units reset to defaults.');
      this.runEval();
    } catch (e) {
      this.setDataMessage(this.dataErrorText(e, 'Could not reset settings.'), true);
    }
  }

  // Here be dragons: wipe all on-device storage and reset to a clean slate.
  async wipeStorage() {
    if (!this.db) return;
    if (
      !confirm(
        'Wipe ALL on-device data — every sheet, revision, custom unit, and setting? calcy resets to a clean slate. This cannot be undone.'
      )
    )
      return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      await this.db.wipeStorage();
      this.applyDefaultSettings();
      this.customUnits = {};
      await this.startFreshSheet();
      await this.refreshSheets();
      this.setDataMessage('On-device storage wiped — calcy is back to a clean slate.');
      this.runEval();
    } catch (e) {
      this.setDataMessage(this.dataErrorText(e, 'Could not wipe storage.'), true);
    }
  }

  private dataErrorText(e: unknown, fallback: string): string {
    return e instanceof Error ? e.message : fallback;
  }

  private setDataMessage(msg: string, error = false) {
    this.dataMessage = msg;
    this.dataError = error;
  }

  // Adopt a brand-new empty sheet as the current document and persist it, so
  // there's always a live sheet after a clear/wipe.
  private async startFreshSheet() {
    if (!this.db) return;
    this.sheetId = crypto.randomUUID();
    this.title = 'Untitled';
    this.body = '';
    this.seed = (Math.random() * 2 ** 31) | 0;
    await this.db.save({ id: this.sheetId, title: this.title, body: this.body, seed: this.seed });
  }

  private applyDefaultSettings() {
    this.monthDays = 30.436875;
    this.yearDays = 365.25;
    this.samples = 10000;
    this.numberFormat = 'auto';
    this.confidence = 0.9;
    this.debugAst = false;
    this.theme = 'system';
  }

  // Re-read content settings + custom units from the DB (after a merge import).
  private async reloadSettingsAndUnits() {
    if (!this.db) return;
    const s = parseSettings(await this.db.getSettings());
    if (s.monthDays !== undefined) this.monthDays = s.monthDays;
    if (s.yearDays !== undefined) this.yearDays = s.yearDays;
    if (s.samples !== undefined) this.samples = s.samples;
    if (s.numberFormat) this.numberFormat = s.numberFormat;
    if (s.confidence !== undefined) this.confidence = s.confidence;
    if (s.theme) this.theme = s.theme;
    this.debugAst = s.debugAst;
    this.customUnits = await this.db.customUnits();
  }

  // --- settings persistence + panel toggles ---------------------------------
  persistSetting(key: string, value: string) {
    this.db?.setSetting(key, value).catch(() => {
      this.saveError = true;
    });
  }

  setMode(mode: 'notepad' | 'tape') {
    this.mode = mode;
    this.persistSetting('mode', mode);
  }

  setTheme(theme: 'system' | 'light' | 'dark') {
    this.theme = theme;
    this.persistSetting('theme', theme);
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

  // Settings is now a floating panel sharing the top-right corner (and scrim)
  // with the other overlays, so opening it closes whatever else was open
  // rather than stacking on top of it. The other openers below return the
  // favour by clearing `showSettings`.
  toggleSettings() {
    const next = !this.showSettings;
    this.closeOverlays();
    this.showSettings = next;
  }

  toggleHelp() {
    this.showHelp = !this.showHelp;
    this.showSettings = false;
    // A plain open clears any error-driven topic so the panel lands at the top.
    this.helpTopic = undefined;
  }

  // Open the cheat sheet focused on a specific group — used by the "see
  // examples" link on an errored line.
  openHelp(topic?: string) {
    this.helpTopic = topic;
    this.showSettings = false;
    this.showHelp = true;
  }

  toggleTemplates() {
    this.showTemplates = !this.showTemplates;
    this.showSettings = false;
  }

  // Docs are mutually exclusive with each other (one reader at a time).
  openGuide() {
    this.showHowItWorks = false;
    this.showReference = false;
    this.showSettings = false;
    this.showGuide = true;
  }

  openReference() {
    this.showGuide = false;
    this.showHowItWorks = false;
    this.showSettings = false;
    this.showReference = true;
  }

  openHowItWorks() {
    this.showGuide = false;
    this.showReference = false;
    this.showSettings = false;
    this.showHowItWorks = true;
  }

  async toggleSheets() {
    this.showSheets = !this.showSheets;
    this.showSettings = false;
    if (this.showSheets) await this.refreshSheets();
  }

  closeOverlays() {
    this.showSheets = false;
    this.showHelp = false;
    this.showSettings = false;
    this.showHistory = false;
    this.showTemplates = false;
    this.showGuide = false;
    this.showReference = false;
    this.showHowItWorks = false;
  }
}
