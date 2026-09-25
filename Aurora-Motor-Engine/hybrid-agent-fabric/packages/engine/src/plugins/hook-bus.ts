export type HookKind = "observer" | "guard" | "transform";
export type HookCallback<TPayload = any, TResult = any> = (payload: TPayload) => TResult | Promise<TResult>;

export interface GuardResult {
  decision: "allow" | "deny";
  reason?: string;
}

interface Subscription {
  pluginId: string;
  hook: string;
  kind: HookKind;
  callback: HookCallback;
  timeoutMs: number;
  queued: number;
  chain: Promise<void>;
}

async function withTimeout<T>(operation: Promise<T> | T, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Plugin hook timed out after ${timeoutMs} ms.`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Typed failure semantics:
 * - observers are bounded, asynchronous and fail-open;
 * - guards are synchronous-at-boundary and fail-closed;
 * - transforms preserve the prior value on failure/timeout.
 */
export class HookBus {
  private readonly subscriptions = new Map<string, Subscription[]>();

  register(input: {
    pluginId: string;
    hook: string;
    kind: HookKind;
    callback: HookCallback;
    timeoutMs?: number;
  }): () => void {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(input.pluginId)) throw new Error("Plugin id is invalid.");
    const subscription: Subscription = {
      pluginId: input.pluginId,
      hook: input.hook,
      kind: input.kind,
      callback: input.callback,
      timeoutMs: input.timeoutMs ?? (input.kind === "observer" ? 1000 : 3000),
      queued: 0,
      chain: Promise.resolve(),
    };
    const list = this.subscriptions.get(input.hook) ?? [];
    list.push(subscription);
    this.subscriptions.set(input.hook, list);
    return () => {
      const current = this.subscriptions.get(input.hook) ?? [];
      this.subscriptions.set(input.hook, current.filter((item) => item !== subscription));
    };
  }

  emitObserver(hook: string, payload: unknown, maxQueuedPerConsumer = 1024): void {
    for (const subscription of this.subscriptions.get(hook) ?? []) {
      if (subscription.kind !== "observer" || subscription.queued >= maxQueuedPerConsumer) continue;
      subscription.queued++;
      subscription.chain = subscription.chain
        .then(async () => {
          try {
            await withTimeout(subscription.callback(structuredClone(payload)), subscription.timeoutMs);
          } catch {
            // Observer failure is intentionally isolated.
          }
        })
        .finally(() => {
          subscription.queued--;
        });
    }
  }

  async invokeGuard(hook: string, payload: unknown): Promise<GuardResult> {
    for (const subscription of this.subscriptions.get(hook) ?? []) {
      if (subscription.kind !== "guard") continue;
      try {
        const result = await withTimeout(subscription.callback(structuredClone(payload)), subscription.timeoutMs) as GuardResult | undefined;
        if (result?.decision === "deny") return result;
      } catch (error) {
        return {
          decision: "deny",
          reason: `Security hook ${subscription.pluginId}:${hook} failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return { decision: "allow" };
  }

  async invokeTransform<T>(hook: string, initial: T): Promise<T> {
    let value = initial;
    for (const subscription of this.subscriptions.get(hook) ?? []) {
      if (subscription.kind !== "transform") continue;
      try {
        const transformed = await withTimeout(subscription.callback(structuredClone(value)), subscription.timeoutMs) as T | undefined;
        if (transformed !== undefined) value = transformed;
      } catch {
        // Transform failure preserves the last good value.
      }
    }
    return value;
  }

  list(): Array<{ pluginId: string; hook: string; kind: HookKind; timeoutMs: number }> {
    return [...this.subscriptions.values()].flat().map(({ pluginId, hook, kind, timeoutMs }) => ({ pluginId, hook, kind, timeoutMs }));
  }
}
