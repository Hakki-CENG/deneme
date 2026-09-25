import { randomUUID } from "node:crypto";
import { auroraInteger, auroraText } from "../util/aurora-state.js";
import type { SandboxFactory } from "./sandbox.js";

const MAX_SHELLS_PER_SESSION = 4;
const MAX_SHELLS_TOTAL = 64;
const MAX_BUFFER_CHARS = 200_000;
const MAX_TOTAL_OUTPUT_CHARS = 5_000_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_WAIT_MS = 60_000;
const RETENTION_MS = 60 * 60_000;

export type BackgroundShellStatus = "running" | "exited" | "killed" | "timed-out" | "failed";

export interface BackgroundShellRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  label: string;
  command: string;
  cwd: string;
  workspacePath: string;
  status: BackgroundShellStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  timeoutMs: number;
  /** Characters the process produced, including anything already evicted from the live buffer. */
  producedChars: number;
  /** Characters dropped from the front of the buffer because the reader fell behind. */
  droppedChars: number;
  /** True once the process hit the total output ceiling and was stopped. */
  outputCapped: boolean;
  stopReason?: string;
  error?: string;
}

export interface BackgroundShellOutput {
  shell: BackgroundShellRecord;
  /** Output between `cursor` and `nextCursor`, in characters produced since the shell started. */
  chunk: string;
  cursor: number;
  nextCursor: number;
  /** Characters skipped because the reader asked for output that had already been evicted. */
  skippedChars: number;
  hasMore: boolean;
  done: boolean;
}

interface LiveShell {
  record: BackgroundShellRecord;
  buffer: string;
  /** Absolute produced-character offset of `buffer[0]`. */
  bufferStart: number;
  controller: AbortController;
  waiters: Set<() => void>;
  completion: Promise<void>;
}

export type BackgroundShellListener = (record: BackgroundShellRecord) => void;

/**
 * Long-running shells with retrievable output and a kill switch.
 *
 * `process.exec` answers "run this and tell me what it said". It cannot answer "start the test suite,
 * go do something else, and check on it" — the call has to be awaited, so a build that outlives the
 * turn has nowhere to live. Peers solve this with a background shell plus two companions: read the
 * output so far, and kill it. This is that surface, with the properties that make it safe here:
 *
 * - **one execution path.** A background shell is the same sandbox `exec` every other command uses, so
 *   the sandbox backend, workspace confinement and environment scrubbing are not re-implemented and
 *   cannot drift. Starting one is governed exactly like `process.exec`.
 * - **bounded memory.** Output lands in a ring buffer with a hard character bound; when a reader falls
 *   behind, the oldest characters are evicted and the loss is *reported* as `skippedChars` rather than
 *   silently stitching a misleading transcript. A cursor is an absolute produced-character offset, so
 *   a reader always knows where it is.
 * - **bounded lifetime.** Every shell has a timeout, a total-output ceiling, and belongs to a session:
 *   when that session closes, its shells are killed. Nothing survives its owner.
 * - **kill is always available.** Stopping never needs an approval, because stopping only ever reduces
 *   what is running — but it is scoped to the caller's own session and the reason is recorded.
 */
export class BackgroundShellService {
  private readonly shells = new Map<string, LiveShell>();
  private readonly listeners = new Set<BackgroundShellListener>();

  constructor(
    private readonly factory: SandboxFactory,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: BackgroundShellListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(input: {
    tenantId: string;
    sessionId: string;
    workspacePath: string;
    command: string;
    cwd?: string | undefined;
    label?: string | undefined;
    timeoutMs?: number | undefined;
    env?: Record<string, string> | undefined;
  }): Promise<BackgroundShellRecord> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const sessionId = auroraText(input.sessionId, 200, "Session ID");
    this.evictFinished();
    const running = [...this.shells.values()].filter((item) => item.record.sessionId === sessionId && item.record.status === "running");
    if (running.length >= MAX_SHELLS_PER_SESSION) {
      throw new Error(`This session already has ${running.length} background shell(s) running; stop one before starting another.`);
    }
    if (this.shells.size >= MAX_SHELLS_TOTAL) throw new Error("Too many background shells are tracked; stop or drain some first.");

    const timeoutMs = auroraInteger(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS, "Shell timeout");
    const record: BackgroundShellRecord = {
      id: `shell-${randomUUID()}`,
      tenantId,
      sessionId,
      label: auroraText(input.label ?? "background shell", 200, "Shell label"),
      command: auroraText(input.command, 50_000, "Shell command"),
      cwd: auroraText(input.cwd ?? ".", 1000, "Shell cwd"),
      workspacePath: input.workspacePath,
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
      timeoutMs,
      producedChars: 0,
      droppedChars: 0,
      outputCapped: false,
    };
    const controller = new AbortController();
    const live: LiveShell = {
      record,
      buffer: "",
      bufferStart: 0,
      controller,
      waiters: new Set(),
      completion: Promise.resolve(),
    };
    this.shells.set(record.id, live);

    const startedAtMs = this.now();
    live.completion = (async () => {
      const sandbox = await this.factory(record.workspacePath);
      try {
        const result = await sandbox.exec({
          command: record.command,
          cwd: record.cwd,
          timeoutMs,
          maxOutputChars: MAX_TOTAL_OUTPUT_CHARS,
          signal: controller.signal,
          ...(input.env ? { env: input.env } : {}),
          onOutput: (chunk) => this.append(live, chunk),
        });
        // Backends that cannot stream (the cloud gateway) hand the whole transcript back at the end;
        // appending only what was not already streamed keeps both paths producing one transcript.
        if (record.producedChars === 0 && result.stdout) this.append(live, result.stdout);
        record.exitCode = result.exitCode;
        if (record.status === "running") {
          record.status = result.timedOut ? "timed-out" : "exited";
        }
        if (result.truncated) record.outputCapped = true;
      } catch (error) {
        if (record.status === "running") {
          record.status = "failed";
          record.error = (error as Error).message.slice(0, 1000);
        }
      } finally {
        await sandbox.destroy().catch(() => undefined);
        record.endedAt = new Date(this.now()).toISOString();
        record.durationMs = this.now() - startedAtMs;
        this.wake(live);
        this.emit(record);
      }
    })();
    live.completion.catch(() => undefined);

    this.emit(record);
    return structuredClone(record);
  }

  /**
   * Read output from `cursor` onwards. With `waitMs` the call blocks until new output arrives or the
   * shell ends, which is how a caller follows a build without hammering the endpoint.
   */
  async output(input: {
    shellId: string;
    sessionId?: string | undefined;
    cursor?: number | undefined;
    maxChars?: number | undefined;
    waitMs?: number | undefined;
  }): Promise<BackgroundShellOutput> {
    const live = this.require(input.shellId, input.sessionId);
    const cursor = Math.max(0, Math.floor(input.cursor ?? 0));
    const maxChars = auroraInteger(input.maxChars ?? 20_000, 100, MAX_BUFFER_CHARS, "Shell output window");
    const waitMs = input.waitMs === undefined ? 0 : auroraInteger(input.waitMs, 0, MAX_WAIT_MS, "Shell output wait");

    if (waitMs > 0 && live.record.status === "running" && cursor >= live.record.producedChars) {
      await this.waitForChange(live, waitMs);
    }
    return this.slice(live, cursor, maxChars);
  }

  async stop(input: { shellId: string; sessionId?: string | undefined; reason: string }): Promise<BackgroundShellRecord> {
    const live = this.require(input.shellId, input.sessionId);
    const reason = auroraText(input.reason, 1000, "Stop reason");
    if (live.record.status !== "running") return structuredClone(live.record);
    live.record.status = "killed";
    live.record.stopReason = reason;
    live.controller.abort();
    this.wake(live);
    this.emit(live.record);
    // The exec promise settles once the process group is gone; waiting keeps `stop` honest about
    // whether the thing is actually dead by the time it answers.
    await live.completion.catch(() => undefined);
    return structuredClone(live.record);
  }

  list(filter: { tenantId?: string | undefined; sessionId?: string | undefined; runningOnly?: boolean | undefined; limit?: number | undefined } = {}): BackgroundShellRecord[] {
    this.evictFinished();
    return [...this.shells.values()]
      .map((item) => item.record)
      .filter((item) => (filter.tenantId ? item.tenantId === filter.tenantId : true))
      .filter((item) => (filter.sessionId ? item.sessionId === filter.sessionId : true))
      .filter((item) => (filter.runningOnly ? item.status === "running" : true))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, auroraInteger(filter.limit ?? 50, 1, 200, "Shell list limit"))
      .map((item) => structuredClone(item));
  }

  get(shellId: string): BackgroundShellRecord | undefined {
    const live = this.shells.get(shellId);
    return live ? structuredClone(live.record) : undefined;
  }

  /** Kill everything a session left running, e.g. when it closes. Nothing outlives its owner. */
  async stopForSession(sessionId: string, reason = "session closed"): Promise<number> {
    const targets = [...this.shells.values()].filter((item) => item.record.sessionId === sessionId && item.record.status === "running");
    for (const target of targets) {
      await this.stop({ shellId: target.record.id, reason }).catch(() => undefined);
    }
    return targets.length;
  }

  private require(shellId: string, sessionId?: string | undefined): LiveShell {
    const live = this.shells.get(shellId);
    if (!live) throw new Error("Background shell not found.");
    // A shell belongs to the session that started it: an id is not a capability grant.
    if (sessionId && live.record.sessionId !== sessionId) throw new Error("Background shell belongs to another session.");
    return live;
  }

  private append(live: LiveShell, chunk: string): void {
    live.record.producedChars += chunk.length;
    live.buffer += chunk;
    if (live.buffer.length > MAX_BUFFER_CHARS) {
      const overflow = live.buffer.length - MAX_BUFFER_CHARS;
      live.buffer = live.buffer.slice(overflow);
      live.bufferStart += overflow;
      live.record.droppedChars += overflow;
    }
    if (live.record.producedChars >= MAX_TOTAL_OUTPUT_CHARS && live.record.status === "running") {
      live.record.outputCapped = true;
      live.record.stopReason = "output ceiling reached";
      live.record.status = "killed";
      live.controller.abort();
    }
    this.wake(live);
  }

  private slice(live: LiveShell, cursor: number, maxChars: number): BackgroundShellOutput {
    const start = Math.max(cursor, live.bufferStart);
    const skippedChars = Math.max(0, start - cursor);
    const available = live.bufferStart + live.buffer.length;
    const end = Math.min(available, start + maxChars);
    const chunk = start >= available ? "" : live.buffer.slice(start - live.bufferStart, end - live.bufferStart);
    return {
      shell: structuredClone(live.record),
      chunk,
      cursor,
      nextCursor: Math.max(start, end),
      skippedChars,
      hasMore: end < available,
      done: live.record.status !== "running" && end >= available,
    };
  }

  private async waitForChange(live: LiveShell, waitMs: number): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      const finish = () => {
        clearTimeout(timer);
        live.waiters.delete(finish);
        resolvePromise();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      live.waiters.add(finish);
    });
  }

  private wake(live: LiveShell): void {
    for (const waiter of [...live.waiters]) waiter();
  }

  private evictFinished(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (const [id, live] of this.shells) {
      if (live.record.status === "running") continue;
      const endedAt = live.record.endedAt ? Date.parse(live.record.endedAt) : 0;
      if (endedAt && endedAt < cutoff) this.shells.delete(id);
    }
  }

  private emit(record: BackgroundShellRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(record));
      } catch {
        // A broken listener must never break shell bookkeeping.
      }
    }
  }
}
