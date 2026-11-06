// Main-thread client for the DB worker.

export interface SheetRow {
  id: string;
  title: string;
  body: string;
  seed: number;
}
export interface SheetListItem {
  id: string;
  title: string;
  updated_at: number;
  snippet?: string;
}
export interface RevisionItem {
  id: number;
  saved_at: number;
  snippet: string;
}

export class DbClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  // false when another tab owns the OPFS database and this tab is running on a
  // transient in-memory copy — changes here will not be saved.
  persistent = true;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, error, result, persistent } = e.data;
      if (typeof persistent === 'boolean') this.persistent = persistent;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    this.ready = this.call<{ persistent: boolean }>('init').then((r) => {
      this.persistent = r?.persistent ?? true;
    });
  }

  private call<T = unknown>(type: string, payload?: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  save(s: SheetRow) {
    return this.call('save', s);
  }
  snapshot(id: string, body: string) {
    return this.call('snapshot', { id, body });
  }
  delete(id: string) {
    return this.call('delete', { id });
  }
  loadLast() {
    return this.call<SheetRow | null>('loadLast');
  }
  loadSheet(id: string) {
    return this.call<SheetRow | null>('loadSheet', { id });
  }
  listRevisions(sheetId: string) {
    return this.call<RevisionItem[]>('listRevisions', { sheetId });
  }
  loadRevision(id: number) {
    return this.call<{ body: string } | null>('loadRevision', { id });
  }
  deleteCustomUnit(name: string) {
    return this.call('deleteCustomUnit', { name });
  }
  list() {
    return this.call<SheetListItem[]>('list');
  }
  search(q: string) {
    return this.call<SheetListItem[]>('search', { q });
  }
  customUnits() {
    return this.call<Record<string, string>>('customUnits');
  }
  setCustomUnit(name: string, definition: string) {
    return this.call('setCustomUnit', { name, definition });
  }
  getSettings() {
    return this.call<Record<string, string>>('getSettings');
  }
  setSetting(key: string, value: string) {
    return this.call('setSetting', { key, value });
  }
  export() {
    return this.call<Uint8Array>('export');
  }
  import(bytes: Uint8Array) {
    return this.call('import', { bytes });
  }
  // Versioned JSON backup: the three tables out, a validated payload back in
  // (merge — existing rows are kept). See $lib/sheet/backup.
  exportData() {
    return this.call<{
      sheets: (SheetRow & { created_at: number; updated_at: number })[];
      custom_units: Record<string, string>;
      settings: Record<string, string>;
    }>('exportData');
  }
  importData(data: unknown) {
    return this.call('importData', data);
  }
  clearSheets() {
    return this.call('clearSheets');
  }
  resetUserData() {
    return this.call('resetUserData');
  }
  wipeStorage() {
    return this.call('wipeStorage');
  }
}
