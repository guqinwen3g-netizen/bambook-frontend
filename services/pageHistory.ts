/** Session-scoped UI navigation. Restoring UI never executes a business command. */
export class PageHistory {
  values = new Map<string, unknown>();
  refreshValues = new Map<string, unknown>();
  private persistQueued = false;
  constructor(private persistence?: { storage: Pick<Storage, 'getItem' | 'setItem'>; key: string; restore?: boolean }) {
    if (!persistence || persistence.restore === false) return;
    try {
      const saved = JSON.parse(persistence.storage.getItem(persistence.key) || 'null');
      const valid = (rows: unknown): rows is [string, unknown][] => Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string');
      if (saved?.version !== 1 || !valid(saved.values) || !valid(saved.refreshValues) || !Array.isArray(saved.entries) || !saved.entries.every(valid)) return;
      this.values = new Map(saved.values);
      this.values.delete('App.workbenchFocus');
      this.refreshValues = new Map(saved.refreshValues);
      this.entries = saved.entries.slice(-30).map((rows: [string, unknown][]) => new Map(rows));
    } catch { /* Corrupt/unavailable session storage falls back to normal navigation. */ }
  }
  persist = () => {
    if (!this.persistence) return;
    try {
      const rows = (map: Map<string, unknown>) => [...map].filter(([key]) => key !== 'App.workbenchFocus');
      const entries = this.pending ? [...this.entries, this.pending] : this.entries;
      this.persistence.storage.setItem(this.persistence.key, JSON.stringify({ version: 1,
        values: rows(this.values), refreshValues: rows(this.refreshValues), entries: entries.slice(-30).map(rows),
      }));
    } catch { /* Storage limits must not block navigation or edits. */ }
  };
  initializeRefresh<T>(key: string, initial: () => T): T {
    if (!this.refreshValues.has(key)) this.refreshValues.set(key, initial());
    return this.refreshValues.get(key) as T;
  }
  setRefresh<T>(key: string, value: T) { this.refreshValues.set(key, value); this.emit(); }
  private entries: Map<string, unknown>[] = [];
  private pending: Map<string, unknown> | null = null;
  private listeners = new Set<() => void>();
  private revision = 0;
  private headerTitles = new Map<object, string>();
  /** The last mounted visible header owns the title, including local forms. */
  registerTitle(id: object, title: string) {
    this.headerTitles.set(id, title);
    this.syncTitle();
    return () => { this.headerTitles.delete(id); this.syncTitle(); };
  }
  updateTitle(id: object, title: string) {
    if (!this.headerTitles.has(id)) return;
    this.headerTitles.set(id, title);
    this.syncTitle();
  }
  private syncTitle() {
    const title = [...this.headerTitles.values()].at(-1);
    if (title !== undefined) this.setTitle(title);
  }
  private localActions = new Map<object, () => { action: () => void | Promise<void>; label: string; disabled: boolean }>();
  get localBack() { return [...this.localActions.values()].at(-1)?.(); }
  registerLocalBack(id: object, read: () => { action: () => void | Promise<void>; label: string; disabled: boolean }) {
    this.localActions.set(id, read); this.emit();
    return () => { this.localActions.delete(id); this.emit(); };
  }
  private beforeReturn = new Set<() => void>();
  onBeforeReturn(listener: () => void) { this.beforeReturn.add(listener); return () => { this.beforeReturn.delete(listener); }; }
  private restoring = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getRevision = () => this.revision;
  get previousTitle() { return String((this.pending ?? this.entries.at(-1))?.get('@pageTitle') ?? '上一页面'); }
  setTitle(title: string) { this.set('@pageTitle', title, false); }
  get canBack() { return this.entries.length > 0 || this.pending !== null; }
  initialize<T>(key: string, initial: () => T): T {
    if (!this.values.has(key)) this.values.set(key, initial());
    return this.values.get(key) as T;
  }
  set<T>(key: string, value: T, location: boolean) {
    const old = this.values.get(key);
    if (Object.is(old, value)) return;
    // A server refresh of the same selected object isn't a navigation.
    const identity = (v: any) => v && typeof v === 'object' && 'id' in v ? v.id : v;
    if (location && !this.restoring && !Object.is(identity(old), identity(value)) && !this.pending) {
      this.pending = new Map(this.values);
      queueMicrotask(() => this.flush());
    }
    this.values = new Map(this.values).set(key, value);
    this.emit();
  }
  flush() {
    if (!this.pending) return;
    // Every registered location change is a forward step, in every module.
    // Only back() pops a step; revisiting a page must not erase its origin.
    this.entries.push(this.pending);
    this.entries = this.entries.slice(-30);
    this.pending = null;
    this.emit();
  }
  /** Sidebar browsing starts a new journey; business links keep using set(). */
  navigateRoot(navigate: () => void) {
    this.entries = [];
    this.pending = null;
    const wasRestoring = this.restoring;
    this.restoring = true;
    try { navigate(); }
    finally { this.restoring = wasRestoring; this.emit(); }
  }
  /** Return to an existing structural view, skipping peer selections in that view. */
  backTo(matches: (values: ReadonlyMap<string, unknown>) => boolean) {
    this.flush();
    let index = this.entries.length - 1;
    while (index >= 0 && !matches(this.entries[index])) index--;
    if (index < 0) return false;
    this.entries = this.entries.slice(0, index + 1);
    return this.back();
  }
  back() {
    this.flush();
    const previous = this.entries.pop();
    if (!previous) return false;
    this.beforeReturn.forEach(listener => listener());
    this.restoring = true;
    this.values = new Map(previous);
    // Focus requests are one-shot commands; the restored module owns its location.
    this.values.set('App.workbenchFocus', undefined);
    this.emit();
    queueMicrotask(() => { this.restoring = false; });
    return true;
  }
  private emit() {
    this.revision++; this.listeners.forEach(listener => listener());
    if (!this.persistQueued) {
      this.persistQueued = true;
      queueMicrotask(() => { this.persistQueued = false; this.persist(); });
    }
  }
}
