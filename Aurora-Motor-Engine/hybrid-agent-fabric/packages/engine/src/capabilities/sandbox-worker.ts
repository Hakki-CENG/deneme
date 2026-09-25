/**
 * Sandbox Worker Entry — Aurora Cognitive Runtime
 *
 * Runs untrusted generated-capability code inside a dedicated worker thread.
 * The worker is spawned with `eval: true` from `SandboxExecutor`, so this file
 * documents and implements the contract that the worker body follows.
 *
 * Isolation properties:
 * - separate V8 isolate (own heap, own globals)
 * - `resourceLimits` enforce max heap / stack; OOM terminates the worker only
 * - no `workerData` inheritance of parent scope
 * - parent applies a wall-clock timeout and calls `terminate()`
 * - `node:vm` context strips `process`, `require` and dynamic `import`
 */

/**
 * Message sent from the host into the sandbox worker.
 */
export interface SandboxWorkerRequest {
  /** Source code of the capability to execute. */
  readonly code: string;
  /** JSON-serialisable input handed to the capability. */
  readonly input: unknown;
  /** Wall-clock budget enforced inside the worker via vm timeout. */
  readonly timeoutMs: number;
}

/**
 * Message emitted by the sandbox worker back to the host.
 */
export interface SandboxWorkerResponse {
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
  /** Console output captured during execution (bounded). */
  readonly logs: readonly string[];
}

/**
 * Worker body executed inside the isolate.
 *
 * Exposed as a string because `new Worker(source, { eval: true })` needs the
 * script text; keeping it here (rather than inline in the executor) keeps the
 * sandbox contract reviewable in one place.
 */
export const SANDBOX_WORKER_SOURCE = /* js */ `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const logs = [];
const MAX_LOGS = 100;
const MAX_LOG_LEN = 2000;

function capture(level) {
  return (...args) => {
    if (logs.length >= MAX_LOGS) return;
    const line = args
      .map((a) => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(" ");
    logs.push(level + ": " + line.slice(0, MAX_LOG_LEN));
  };
}

async function run() {
  const { code, input, timeoutMs } = workerData;

  // Frozen, minimal global surface. No process/require/import inside the vm.
  const sandboxGlobals = {
    console: {
      log: capture("log"),
      warn: capture("warn"),
      error: capture("error"),
      info: capture("info"),
      debug: capture("debug"),
    },
    input,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Promise,
    RegExp,
    Error,
    TypeError,
    RangeError,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
structuredClone: typeof structuredClone === "function" ? structuredClone : undefined,
  };

  const context = vm.createContext(sandboxGlobals, {
    codeGeneration: { strings: false, wasm: false },
  });

  // The capability body is wrapped in an async IIFE so both sync returns and
  // awaited promises resolve through the same path.
  const wrapped =
    "(async () => {\\n" + code + "\\n})()";

  const script = new vm.Script(wrapped, { filename: "capability.js" });
  const result = await script.runInContext(context, { timeout: timeoutMs });
  return result;
}

run()
  .then((output) => {
    let safe;
    try {
      // Force a structured-clone-safe payload across the thread boundary.
      safe = JSON.parse(JSON.stringify(output === undefined ? null : output));
    } catch {
      safe = String(output);
    }
    parentPort.postMessage({ ok: true, output: safe, logs });
  })
  .catch((err) => {
    parentPort.postMessage({
      ok: false,
      error: err && err.message ? String(err.message) : String(err),
      logs,
    });
  });
`;
