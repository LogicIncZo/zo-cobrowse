import vm from "node:vm";

/**
 * The ONE place in the test suite that evaluates extension source slices.
 *
 * The extension ships `content.js` as a classic MV3 content script (the
 * browser forbids module imports there) and keeps its streaming/safety
 * internals unexported — so the harness exercises real internals by running
 * source slices in a `node:vm` sandbox seeded with fake-chrome / happy-dom
 * globals (see AGENTS.md § Tests, "Integration layer"). This is deliberate,
 * sandboxed test infrastructure operating on trusted in-repo source — not
 * application code handling untrusted input. All `vm.runInContext` uses in
 * the suite go through here so the pattern has a single audited choke point.
 */
export function runInSandbox(code: string, sandbox: Record<string, unknown>): void {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "extension-source-slice.js" });
}
