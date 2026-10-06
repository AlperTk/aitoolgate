/**
 * Rich DOM stub for loading the vanilla-JS dashboard ES modules (.mjs) under Node
 * for unit tests. Follows the same zero-dependency approach as
 * tests/dashboard-ws-url.test.ts (installDomStub / FakeEl), but models the extra
 * APIs the live-view / controls / rules modules touch: value, hidden, dataset,
 * style.display, a live children array, classList, addEventListener/emit, and a
 * real document.body. It also captures <a> anchors created by downloadFile() and
 * every Blob passed to URL.createObjectURL so export behaviour can be asserted.
 *
 * Each test FILE runs in its own process under `node --test`, so installing one
 * stub per file never leaks across files. install via createDomStub(), which also
 * wires globalThis.document + a Node-safe URL shim (createObjectURL/revokeObjectURL
 * do not exist in Node). Native Blob is used for the actual downloaded content.
 * The `document` handle is typed as `any` deliberately: this project builds with
 * lib:["ESNext"] + @types/node (no DOM lib), so we keep the stub itself free of
 * DOM-specific type references while the modules under test only see duck-typed
 * elements.
 */
export class FakeEl {
  tagName = 'DIV';
  id = '';
  href = '';
  download = '';
  title = '';
  type = '';
  value = '';
  checked = false;
  hidden = false;
  rows = 0;
  step = '';
  htmlFor = '';
  clicked = false;
  dataset: Record<string, string> = {};
  style: { display: string } = { display: '' };
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  private _classes = new Set<string>();
  private _text = '';
  private _attrs: Record<string, string> = {};
  private _listeners: Record<string, Array<(e?: unknown) => void>> = {};

  constructor(tag?: string) {
    this.tagName = (tag || 'div').toUpperCase();
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  set className(v: string) {
    this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }
  get classList(): {
    add: (...t: string[]) => void;
    remove: (...t: string[]) => void;
    toggle: (t: string, f?: boolean) => boolean;
    contains: (t: string) => boolean;
  } {
    const self = this;
    return {
      add: (...t: string[]): void => t.forEach((x) => self._classes.add(x)),
      remove: (...t: string[]): void => t.forEach((x) => self._classes.delete(x)),
      toggle: (t: string, f?: boolean): boolean => {
        const want = f === undefined ? !self._classes.has(t) : !!f;
        if (want) self._classes.add(t);
        else self._classes.delete(t);
        return want;
      },
      contains: (t: string): boolean => self._classes.has(t),
    };
  }
  // Assigning textContent removes all existing child nodes (real-DOM semantics):
  // re-renders that clear via `el.textContent = ''` replace rows instead of
  // accumulating stale children left over from prior renders.
  get textContent(): string {
    return this._text;
  }
  set textContent(v: unknown) {
    this._text = String(v);
    this.children.length = 0;
  }
  setAttribute(k: string, v: string): void {
    this._attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(n: FakeEl): FakeEl {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  insertBefore(n: FakeEl, ref: FakeEl | null): FakeEl {
    n.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n);
    else this.children.splice(i, 0, n);
    return n;
  }
  removeChild(n: FakeEl): FakeEl {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  get firstChild(): FakeEl | null {
    return this.children[0] || null;
  }
  get lastChild(): FakeEl | null {
    return this.children[this.children.length - 1] || null;
  }
  querySelector(_sel: string): FakeEl | null {
    return null;
  }
  querySelectorAll(_sel: string): FakeEl[] {
    return [];
  }
  // Register a listener for an event type (mirrors HTMLElement.addEventListener).
  addEventListener(type: string, fn: (e?: unknown) => void): void {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(fn);
  }
  // Fire all registered listeners for `type` with `this` = the element (the same
  // dispatch semantics the real modules rely on when they read control values).
  emit(type: string): void {
    (this._listeners[type] || []).slice().forEach((fn) => fn.call(this, {}));
  }
  click(): void {
    this.clicked = true;
    this.emit('click');
  }
}

export interface DomStub {
  document: any;
  body: FakeEl;
  anchors: FakeEl[];
  blobs: any[];
  byId(id: string): FakeEl | undefined;
  el(id: string, tag?: string): FakeEl;
  createElement(tag: string): FakeEl;
}

// Build a fresh DOM stub and install it on globalThis.document (+ URL shim).
// Returns handles to fetch elements by id, create + register elements, and read
// captured anchors/blobs. Callers materialize the specific dashboard elements via
// stub.el(id, tag).
export function createDomStub(): DomStub {
  const registry = new Map<string, FakeEl>();
  const body = new FakeEl('body');
  const stub: DomStub = {
    document: null as any,
    body,
    anchors: [],
    blobs: [],
    byId: (id: string) => registry.get(id),
    el: (id: string, tag?: string) => {
      const e = new FakeEl(tag || 'div');
      e.id = id;
      registry.set(id, e);
      return e;
    },
    createElement: (tag: string) => {
      const e = new FakeEl(tag);
      if (tag === 'a') stub.anchors.push(e);
      return e;
    },
  };
  stub.document = {
    getElementById: (id: string) => registry.get(id) || null,
    createElement: (t: string) => stub.createElement(t),
    body,
    querySelectorAll: (_sel: string) => [] as unknown[],
  };

  // Install on the global object so dashboard modules that reference bare
  // `document` / `URL` see our stubs. Node has no URL.createObjectURL, so shim
  // it (capturing each Blob) while keeping native URL parsing intact.
  const RealURL: any = (globalThis as unknown as Record<string, unknown>).URL;
  (globalThis as unknown as Record<string, unknown>).document = stub.document;
  (globalThis as unknown as Record<string, unknown>).URL = class extends RealURL {
    static createObjectURL(blob: unknown): string {
      stub.blobs.push(blob as any);
      return 'blob:fake-' + stub.blobs.length;
    }
    static revokeObjectURL(_url?: string): void {
      /* no-op in tests */
    }
  };
  return stub;
}
