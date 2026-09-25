import { createHash } from "node:crypto";
import { connect, type Codec } from "@nats-io/transport-node";
import type { CommandEnvelope, CommandResult, EventEnvelope } from "../../types.js";
import type { EventStore } from "../../persistence/event-store.js";

/**
 * JSON codec for message payloads.
 *
 * `@nats-io/transport-node` v3 dropped the JSON codec factory that v2 shipped and
 * kept only the `Codec<T>` interface, so the implementation lives here now. It is
 * the same behaviour v2 had -- UTF-8 JSON -- and the existing tests still pin it:
 * the event bridge test parses the published bytes as JSON, and the command bus
 * test round-trips a request through encode and decode.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonCodec<T>(): Codec<T> {
  return {
    encode: (value: T) => encoder.encode(JSON.stringify(value)),
    decode: (data: Uint8Array) => JSON.parse(decoder.decode(data)) as T,
  };
}

interface NatsMessageLike {
  data: Uint8Array;
  respond(data?: Uint8Array): boolean;
}

interface NatsSubscriptionLike extends AsyncIterable<NatsMessageLike> {
  unsubscribe(): void;
}

export interface NatsConnectionLike {
  publish(subject: string, data?: Uint8Array): void;
  subscribe(subject: string): NatsSubscriptionLike;
  request(subject: string, data?: Uint8Array, options?: { timeout?: number }): Promise<{ data: Uint8Array }>;
  drain(): Promise<void>;
}

export interface NatsTransportOptions {
  servers: string | string[];
  token?: string;
  user?: string;
  pass?: string;
  prefix?: string;
  connection?: NatsConnectionLike;
}

function subjectToken(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  if (!normalized) throw new Error("NATS subject token is empty.");
  return normalized;
}

function tenantToken(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 24);
}

export class NatsTransport {
  private connection: NatsConnectionLike | undefined;
  private ownsConnection = false;
  readonly prefix: string;

  constructor(private readonly options: NatsTransportOptions) {
    this.prefix = subjectToken(options.prefix ?? "haf");
    if (options.connection) this.connection = options.connection;
  }

  async getConnection(): Promise<NatsConnectionLike> {
    if (this.connection) return this.connection;
    this.connection = await connect({
      servers: this.options.servers,
      ...(this.options.token ? { token: this.options.token } : {}),
      ...(this.options.user ? { user: this.options.user } : {}),
      ...(this.options.pass ? { pass: this.options.pass } : {}),
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    this.ownsConnection = true;
    return this.connection;
  }

  eventSubject(tenantId: string): string {
    return `${this.prefix}.events.${tenantToken(tenantId)}`;
  }

  commandSubject(workerId: string): string {
    return `${this.prefix}.commands.${subjectToken(workerId)}`;
  }

  async close(): Promise<void> {
    if (this.connection && this.ownsConnection) await this.connection.drain();
    this.connection = undefined;
  }
}

export class NatsEventBridge {
  private unsubscribeStore: (() => void) | undefined;
  private started = false;
  private readonly codec = jsonCodec<EventEnvelope>();

  constructor(
    private readonly transport: NatsTransport,
    private readonly events: EventStore,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    const connection = await this.transport.getConnection();
    this.unsubscribeStore = this.events.subscribeAll((event) => {
      connection.publish(this.transport.eventSubject(event.tenantId), this.codec.encode(event));
    });
    this.started = true;
  }

  stop(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.started = false;
  }
}

export class NatsCommandBus {
  private readonly requestCodec = jsonCodec<CommandEnvelope>();
  private readonly responseCodec = jsonCodec<CommandResult>();
  private readonly subscriptions = new Set<NatsSubscriptionLike>();

  constructor(private readonly transport: NatsTransport) {}

  async serve(workerId: string, handler: (command: CommandEnvelope) => Promise<CommandResult>): Promise<() => void> {
    const connection = await this.transport.getConnection();
    const subscription = connection.subscribe(this.transport.commandSubject(workerId));
    this.subscriptions.add(subscription);
    let active = true;
    void (async () => {
      for await (const message of subscription) {
        if (!active) break;
        let result: CommandResult;
        try {
          const command = this.requestCodec.decode(message.data);
          result = await handler(command);
        } catch (error) {
          result = {
            commandId: "unknown",
            status: "rejected",
            error: { code: "NATS_COMMAND_INVALID", message: error instanceof Error ? error.message : String(error), retryable: false },
          };
        }
        message.respond(this.responseCodec.encode(result));
      }
    })();
    return () => {
      active = false;
      subscription.unsubscribe();
      this.subscriptions.delete(subscription);
    };
  }

  async request(workerId: string, command: CommandEnvelope, timeoutMs = 120_000): Promise<CommandResult> {
    const connection = await this.transport.getConnection();
    const response = await connection.request(
      this.transport.commandSubject(workerId),
      this.requestCodec.encode(command),
      { timeout: timeoutMs },
    );
    return this.responseCodec.decode(response.data);
  }

  close(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.clear();
  }
}
