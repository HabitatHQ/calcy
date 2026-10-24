// Main-thread client for the engine worker: promise-per-request over postMessage.

import type {
  DisplayValue,
  EngineOptions,
  RatePeriod,
  SensitivityEntry,
  SheetResult
} from './index';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class EngineClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, error, ...rest } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(rest);
    };
  }

  private send<T>(payload: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...payload, id });
    });
  }

  async evalSheet(
    text: string,
    opts: Partial<EngineOptions> = {},
    customUnits: Record<string, string> = {}
  ): Promise<SheetResult> {
    // opts/customUnits may be Svelte $state proxies, which structured-clone
    // cannot serialise for postMessage — spread into plain objects first.
    const { result } = await this.send<{ result: SheetResult }>({
      type: 'eval',
      text,
      opts: { ...opts },
      customUnits: { ...customUnits }
    });
    return result;
  }

  async accumulate(
    lineIndex: number,
    period: RatePeriod,
    count: number,
    growth = 0
  ): Promise<DisplayValue | null> {
    const { display } = await this.send<{ display: DisplayValue | null }>({
      type: 'accumulate',
      lineIndex,
      period,
      count,
      growth
    });
    return display;
  }

  async sensitivity(lineIndex: number): Promise<SensitivityEntry[] | null> {
    const { entries } = await this.send<{ entries: SensitivityEntry[] | null }>({
      type: 'sensitivity',
      lineIndex
    });
    return entries;
  }

  async unitNames(): Promise<string[]> {
    const { names } = await this.send<{ names: string[] }>({ type: 'unitNames' });
    return names;
  }

  async stats(lineIndex: number): Promise<{ label: string; value: string }[] | null> {
    const { rows } = await this.send<{ rows: { label: string; value: string }[] | null }>({
      type: 'stats',
      lineIndex
    });
    return rows;
  }

  destroy() {
    this.worker.terminate();
    for (const pending of this.pending.values())
      pending.reject(new Error('engine client was disposed'));
    this.pending.clear();
  }
}
