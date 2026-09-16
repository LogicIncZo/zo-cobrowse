// Shared Chrome Extension API fake for Zo Co-browse integration tests.
//
// This is a real message BUS, not a bag of no-op stubs: runtime.sendMessage
// actually dispatches to registered onMessage listeners (Chrome response
// semantics: first sendResponse wins, `return true` keeps the channel open),
// runtime.connect() returns a live Port PAIR so the sidepanel's posts reach
// the background's onConnect listener and vice versa, storage areas keep real
// stores and broadcast storage.onChanged, and tabs.sendMessage routes to a
// per-tab message target registered via tabs.bindTab() (a content script
// mounted in a vm/happy-dom sandbox — see tests/integration/).
//
// Mounting recipe (see tests/integration/*.test.ts):
//   const bus = createFakeChrome();
//   (globalThis as any).chrome = bus;            // BEFORE importing background.js
//   await import("../../extension/background.js?file=background-flow");

/** Chrome-style event: addListener/removeListener/hasListener + emit. */
export class FakeEvent {
  listeners = new Set<Function>();
  /** Listener throws are collected here (and logged) instead of breaking delivery. */
  errors: unknown[] = [];

  addListener(fn: Function): Function {
    this.listeners.add(fn);
    return fn;
  }
  removeListener(fn: Function): void {
    this.listeners.delete(fn);
  }
  hasListener(fn: Function): boolean {
    return this.listeners.has(fn);
  }
  emit(...args: unknown[]): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(...args);
      } catch (err) {
        this.errors.push(err);
        console.error("[chrome-mock] listener threw:", err);
      }
    }
  }
}

/**
 * Deliver a message to an event with chrome.runtime.sendMessage semantics.
 * Resolves with the first sendResponse value; if no listener answered
 * synchronously and none returned `true`, resolves undefined.
 */
export function dispatchToEvent(evt: FakeEvent, msg: unknown, sender: unknown = {}): Promise<any> {
  return new Promise((resolve) => {
    let responded = false;
    let asyncOpen = false;
    const respond = (val: any) => {
      if (!responded) {
        responded = true;
        resolve(val);
      }
    };
    queueMicrotask(() => {
      for (const fn of [...evt.listeners]) {
        let ret: unknown;
        try {
          ret = fn(msg, sender, respond);
        } catch (err) {
          evt.errors.push(err);
          console.error("[chrome-mock] sendMessage listener threw:", err);
        }
        if (ret === true) asyncOpen = true;
      }
      if (!responded && !asyncOpen) resolve(undefined);
    });
  });
}

/**
 * One end of a connected port pair. postMessage() delivers to the PEER's
 * onMessage listeners on a microtask (Chrome delivers async); disconnect()
 * marks both ends dead and fires the peer's onDisconnect. The `_dead` flag
 * mirrors the convention background.js's safePost() relies on.
 */
export class FakePort {
  readonly name: string;
  _dead = false;
  onMessage = new FakeEvent();
  onDisconnect = new FakeEvent();
  #peer: FakePort | null = null;

  constructor(name: string) {
    this.name = name;
  }

  static pair(name: string): [FakePort, FakePort] {
    const a = new FakePort(name);
    const b = new FakePort(name);
    a.#peer = b;
    b.#peer = a;
    return [a, b];
  }

  postMessage(msg: unknown): void {
    if (this._dead) throw new Error("Attempting to use a disconnected port object");
    const peer = this.#peer!;
    queueMicrotask(() => {
      if (!peer._dead) peer.onMessage.emit(msg);
    });
  }

  disconnect(): void {
    if (this._dead) return;
    this._dead = true;
    const peer = this.#peer!;
    peer._dead = true;
    queueMicrotask(() => peer.onDisconnect.emit());
  }
}

function makeStorageArea(area: string, onChanged: FakeEvent) {
  const store: Record<string, any> = {};
  const emitChanges = (changes: Record<string, { oldValue: any; newValue: any }>) => {
    if (Object.keys(changes).length) queueMicrotask(() => onChanged.emit(changes, area));
  };
  return {
    /** Direct store access for seeding before a module import. */
    _store: store,
    get(keys: any = null, cb?: Function): Promise<any> {
      if (typeof keys === "function") {
        cb = keys;
        keys = null;
      }
      let result: Record<string, any>;
      if (keys === null || keys === undefined) {
        result = { ...store };
      } else if (typeof keys === "string") {
        result = { [keys]: store[keys] ?? undefined };
      } else if (Array.isArray(keys)) {
        result = {};
        for (const k of keys) result[k] = store[k] ?? undefined;
      } else {
        result = {};
        for (const k of Object.keys(keys)) result[k] = k in store ? store[k] : keys[k];
      }
      if (cb) queueMicrotask(() => cb(result));
      return Promise.resolve(result);
    },
    set(items: Record<string, any>, cb?: Function): Promise<void> {
      const changes: Record<string, { oldValue: any; newValue: any }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: k in store ? store[k] : undefined, newValue: v };
        store[k] = v;
      }
      if (cb) queueMicrotask(() => cb());
      emitChanges(changes);
      return Promise.resolve();
    },
    remove(keys: string | string[], cb?: Function): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, { oldValue: any; newValue: any }> = {};
      for (const k of list) {
        changes[k] = { oldValue: k in store ? store[k] : undefined, newValue: undefined };
        delete store[k];
      }
      if (cb) queueMicrotask(() => cb());
      emitChanges(changes);
      return Promise.resolve();
    },
    clear(cb?: Function): Promise<void> {
      const changes: Record<string, { oldValue: any; newValue: any }> = {};
      for (const k of Object.keys(store)) {
        changes[k] = { oldValue: store[k], newValue: undefined };
        delete store[k];
      }
      if (cb) queueMicrotask(() => cb());
      emitChanges(changes);
      return Promise.resolve();
    },
    getBytesInUse(_keys?: any, cb?: Function): Promise<number> {
      if (cb) cb(0);
      return Promise.resolve(0);
    },
  };
}

/**
 * A content-script message target — the chrome object a vm-mounted content.js
 * sees. Its onMessage event is what bus.tabs.bindTab(tabId, ...) wires
 * chrome.tabs.sendMessage(tabId, msg) to, mirroring how a real content script
 * only receives messages addressed to its tab.
 */
export function createTabTarget() {
  const onMessage = new FakeEvent();
  return {
    chrome: { runtime: { onMessage } },
    onMessage,
    /** Test-side dispatch: invoke the content listeners with (msg, sender, sendResponse). */
    dispatch(msg: unknown): Promise<any> {
      return dispatchToEvent(onMessage, msg, { tab: { id: -1 } });
    },
  };
}

/**
 * The full extension bus. One instance per test file; install it on
 * globalThis BEFORE dynamically importing background.js/sidepanel.js
 * (use a cache-busting query string — bun shares the module registry
 * across test files in one process).
 */
export function createFakeChrome(): any {
  const runtimeOnMessage = new FakeEvent();
  const runtimeOnConnect = new FakeEvent();
  const storageOnChanged = new FakeEvent();

  const runtime: any = {
    id: "test-extension-id",
    lastError: undefined,
    onMessage: runtimeOnMessage,
    onConnect: runtimeOnConnect,
    onInstalled: new FakeEvent(),
    onStartup: new FakeEvent(),
    sendMessage: (msg: any) => dispatchToEvent(runtimeOnMessage, msg, { tab: { id: undefined } }),
    connect: (connectInfo?: { name?: string }) => {
      const [caller, listener] = FakePort.pair(connectInfo?.name || "");
      runtime._lastPeer = listener;
      queueMicrotask(() => runtimeOnConnect.emit(listener));
      return caller;
    },
    openOptionsPage: () => {},
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    /** Manifest version is MUTABLE via _setManifestVersion (install-state
     * tests simulate an extension update bumping the version). */
    getManifest: () => ({ name: "zo-cobrowse", version: runtime._manifestVersion }),
    /** Most recent connect() listener-side port (the background's end). */
    _lastPeer: null as FakePort | null,
    _manifestVersion: "0.2.9.0",
  };

// ---- tabs ----
const tabs: any[] = [];
const tabTargets = new Map<number, FakeEvent>();
const calls: Array<{ api: string; tabId?: number; msg?: any; target?: any; funcName?: string }> = [];
let nextTabId = 100;

const tabsApi: any = {
  _tabs: tabs,
  _calls: calls,
  registerTab(tab: any) {
    if (tab.id == null) tab.id = nextTabId++;
    if (tab.windowId == null) tab.windowId = 1;
    if (tab.currentWindow == null) tab.currentWindow = true;
    tabs.push(tab);
    return tab;
  },
  /** Route chrome.tabs.sendMessage(tabId, msg) to a content-script target. */
  bindTab(tabId: number, evt: FakeEvent) {
    tabTargets.set(tabId, evt);
  },
  query: (q: any = {}) =>
    Promise.resolve(
      tabs.filter((t) => (!q.active || t.active) && (!q.currentWindow || t.currentWindow !== false)),
    ),
  get: (tabId: number) => {
    const t = tabs.find((x) => x.id === tabId);
    return t ? Promise.resolve(t) : Promise.reject(new Error(`No tab with id: ${tabId}`));
  },
  update: (tabId: number, props: any) => {
    const t = tabs.find((x) => x.id === tabId);
    if (t) Object.assign(t, props);
    return t ? Promise.resolve(t) : Promise.reject(new Error(`No tab with id: ${tabId}`));
  },
  sendMessage: (tabId: number, msg: any) => {
    calls.push({ api: "tabs.sendMessage", tabId, msg });
    const target = tabTargets.get(tabId);
    if (!target) {
      return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
    }
    return dispatchToEvent(target, msg, { tab: { id: tabId } });
  },
  create: (props: any = {}) => {
    tabsCreateCalls.push({ ...props });
    const t = { id: nextTabId++, active: !!props.active, windowId: 1, currentWindow: true, ...props };
    tabs.push(t);
    return Promise.resolve(t);
  },
  captureVisibleTab: () => Promise.resolve("data:image/jpeg;base64,/9j/ZmFrZQ=="),
  onRemoved: new FakeEvent(),
  onActivated: new FakeEvent(),
  onUpdated: new FakeEvent(),
};

  // ---- debugger (CDP fast-path) ----
  // Disabled by default so getActiveTabContext()/executeActions() fall through
  // to the content-script path, exactly like a tab without the debugger
  // attached. Flip `debugger.enabled = true` + set `evalHandler` to exercise
  // the CDP path.
  const debuggerApi: any = {
    enabled: false,
    evalHandler: null as null | ((expression: string) => unknown),
    _attached: new Set<number>(),
    _calls: [] as Array<{ api: string; tabId?: number; method?: string; expression?: string }>,
    attach: (target: { tabId: number }, _version: string) => {
      debuggerApi._calls.push({ api: "attach", tabId: target?.tabId });
      if (!debuggerApi.enabled) return Promise.reject(new Error("Fake debugger attach refused"));
      debuggerApi._attached.add(target.tabId);
      return Promise.resolve();
    },
    detach: (target: { tabId: number }) => {
      debuggerApi._calls.push({ api: "detach", tabId: target?.tabId });
      debuggerApi._attached.delete(target?.tabId);
      return Promise.resolve();
    },
    sendCommand: (target: { tabId: number }, method: string, params: any) => {
      debuggerApi._calls.push({ api: "sendCommand", tabId: target?.tabId, method, expression: params?.expression });
      if (!debuggerApi.enabled || typeof debuggerApi.evalHandler !== "function") {
        return Promise.reject(new Error(`Fake debugger sendCommand refused: ${method}`));
      }
      const value = debuggerApi.evalHandler(params?.expression);
      return Promise.resolve({ result: { value } });
    },
    onDetach: new FakeEvent(),
  };

  // ---- scripting (executeScript fallback path) ----
  // When `dom` is set to a happy-dom Window, injected funcs are actually run
  // against that DOM (background serialises real self-contained functions).
  const scriptingApi: any = {
    dom: null as any,
    executeScript: ({ target, func, args = [] }: any) => {
      calls.push({ api: "scripting.executeScript", target, funcName: func?.name });
      const dom = scriptingApi.dom;
      if (!dom || typeof func !== "function") {
        return Promise.reject(new Error("Fake scripting.executeScript refused (no DOM configured)"));
      }
      // Rebind the injected function's free document/window/location/Event/CSS
      // references to the happy-dom instance for the duration of the call —
      // the real extension serialises self-contained page-side functions.
      const g = globalThis as any;
      const domGlobals: Record<string, any> = {
        document: dom.document,
        window: dom,
        location: dom.location,
        Event: dom.Event,
        CSS: dom.CSS,
      };
      const prev: Record<string, any> = {};
      for (const key of Object.keys(domGlobals)) {
        prev[key] = g[key];
        g[key] = domGlobals[key];
      }
      return Promise.resolve([{}]).then(async () => {
        try {
          return [{ result: await func(...args) }];
        } finally {
          for (const key of Object.keys(domGlobals)) {
            g[key] = prev[key];
          }
        }
      });
    },
    insertCSS: () => Promise.resolve(),
  };

  // ---- contextMenus ----
  const menus: any[] = [];
  const contextMenusApi: any = {
    _menus: menus,
    create: (opts: any) => {
      menus.push(opts);
      return opts?.id;
    },
    removeAll: (cb?: Function) => {
      menus.length = 0;
      if (cb) queueMicrotask(() => cb());
    },
    onClicked: new FakeEvent(),
  };

  // ---- omnibox ----
  const omniboxApi: any = {
    _defaultSuggestions: [] as any[],
    setDefaultSuggestion: (s: any) => {
      omniboxApi._defaultSuggestions.push(s);
    },
    onInputStarted: new FakeEvent(),
    onInputChanged: new FakeEvent(),
    onInputEntered: new FakeEvent(),
  };

  const mock = {
    runtime,
    storage: {
      sync: makeStorageArea("sync", storageOnChanged),
      local: makeStorageArea("local", storageOnChanged),
      managed: makeStorageArea("managed", storageOnChanged),
      session: makeStorageArea("session", storageOnChanged),
      onChanged: storageOnChanged,
    },
    tabs: tabsApi,
    debugger: debuggerApi,
    scripting: scriptingApi,
    contextMenus: contextMenusApi,
    omnibox: omniboxApi,
    sidePanel: {
      open: () => Promise.resolve(),
      setOptions: () => Promise.resolve(),
      setPanelBehavior: () => Promise.resolve(),
    },
    commands: {
      getAll: (cb?: Function) => {
        if (cb) cb([]);
        return Promise.resolve([]);
      },
      onCommand: new FakeEvent(),
    },
    action: {
      onClicked: new FakeEvent(),
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      setIcon: () => {},
    },
    tts: {
      speak: (_text: string, opts?: any) => {
        if (opts?.onEvent) queueMicrotask(() => opts.onEvent({ type: "end", charIndex: 0 }));
      },
      stop: () => {},
    },
    windows: {
      getCurrent: () => Promise.resolve({ id: 1 }),
      onCreated: new FakeEvent(),
      onRemoved: new FakeEvent(),
    },
    i18n: {
      getMessage: () => "",
      getUILanguage: () => "en",
    },
    permissions: {
      contains: () => Promise.resolve(false),
      request: () => Promise.resolve(true),
    },
  };
  return mock;
}

// Back-compat aliases (the pre-bus mock exported these names).
export const createMockChrome = createFakeChrome;
export function installChromeMock(globalObj: any, mock: any) {
  globalObj.chrome = mock;
}
export function uninstallChromeMock(globalObj: any) {
  delete globalObj.chrome;
}

// Recorded chrome.tabs.create calls (url + active flag) — carried over from
// the pre-bus mock so call-recording assertions keep working.
export let tabsCreateCalls: Array<{ url?: string; active?: boolean }> = [];
export function resetTabsCreateCalls() {
  tabsCreateCalls = [];
}

/** Poll until pred() is true; throws on timeout. The integration tests' main sync point. */
export async function waitUntil(pred: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Stub getBoundingClientRect non-zero on a happy-dom window (both libs report 0s). */
export function stubNonZeroRects(win: any, { width = 120, height = 32 } = {}) {
  const rect = {
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
    toJSON() { return { ...rect }; },
  };
  for (const proto of [win.HTMLElement?.prototype, win.Element?.prototype]) {
    if (proto) proto.getBoundingClientRect = () => ({ ...rect });
  }
}
