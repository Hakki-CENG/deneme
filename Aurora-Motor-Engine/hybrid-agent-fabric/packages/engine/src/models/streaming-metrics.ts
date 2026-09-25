/**
 * Streaming Metrics — Aurora Cognitive Runtime
 *
 * TTFB (Time to First Byte) ve tokens/sec ölçümü.
 * Tüm provider'larda streaming performansını izler.
 */

export interface StreamingMetrics {
  /** Time to First Byte (ms) */
  ttfbMs: number;
  /** Time to First Token (ms) */
  ttftMs: number;
  /** Total streaming duration (ms) */
  totalDurationMs: number;
  /** Tokens per second */
  tokensPerSecond: number;
  /** Total tokens received */
  totalTokens: number;
  /** Total characters received */
  totalCharacters: number;
  /** Characters per second */
  charactersPerSecond: number;
  /** Stream was interrupted */
  interrupted: boolean;
  /** Error if any */
  error?: string;
}

export interface StreamingMetricsCollector {
  /** Stream başladığında çağrılır */
  onStreamStart(): void;
  /** İlk byte geldiğinde çağrılır */
  onFirstByte(): void;
  /** İlk token geldiğinde çağrılır */
  onFirstToken(): void;
  /** Her token geldiğinde çağrılır */
  onToken(token: string): void;
  /** Stream bittiğinde çağrılır */
  onStreamEnd(): void;
  /** Hata olduğunda çağrılır */
  onStreamError(error: Error): void;
  /** Metrikleri al */
  getMetrics(): StreamingMetrics;
}

export class StreamingMetricsCollectorImpl implements StreamingMetricsCollector {
  private startTime = 0;
  private firstByteTime = 0;
  private firstTokenTime = 0;
  private endTime = 0;
  private totalTokens = 0;
  private totalCharacters = 0;
  private interrupted = false;
  private error?: string;

  onStreamStart(): void {
    this.startTime = performance.now();
  }

  onFirstByte(): void {
    if (this.firstByteTime === 0) {
      this.firstByteTime = performance.now();
    }
  }

  onFirstToken(): void {
    if (this.firstTokenTime === 0) {
      this.firstTokenTime = performance.now();
    }
  }

  onToken(token: string): void {
    this.totalTokens++;
    this.totalCharacters += token.length;
  }

  onStreamEnd(): void {
    this.endTime = performance.now();
  }

  onStreamError(error: Error): void {
    this.endTime = performance.now();
    this.interrupted = true;
    this.error = error.message;
  }

  getMetrics(): StreamingMetrics {
    const now = this.endTime || performance.now();
    const totalDurationMs = now - this.startTime;
    const ttfbMs = this.firstByteTime > 0 ? this.firstByteTime - this.startTime : 0;
    const ttftMs = this.firstTokenTime > 0 ? this.firstTokenTime - this.startTime : 0;
    const tokensPerSecond = totalDurationMs > 0 ? (this.totalTokens / totalDurationMs) * 1000 : 0;
    const charactersPerSecond = totalDurationMs > 0 ? (this.totalCharacters / totalDurationMs) * 1000 : 0;

    return {
      ttfbMs,
      ttftMs,
      totalDurationMs,
      tokensPerSecond,
      totalTokens: this.totalTokens,
      totalCharacters: this.totalCharacters,
      charactersPerSecond,
      interrupted: this.interrupted,
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

/**
 * Streaming wrapper — herhangi bir AsyncIterable'i metrics ile sarar.
 */
export async function* withStreamingMetrics<T>(
  stream: AsyncIterable<T>,
  metrics: StreamingMetricsCollectorImpl
): AsyncIterable<T> {
  metrics.onStreamStart();

  try {
    for await (const chunk of stream) {
      metrics.onFirstByte();
      
      // Token olarak sayabileceğimiz chunk'lar
      if (typeof chunk === "object" && chunk !== null) {
        const event = chunk as any;
        if (event.type === "text_delta" && event.delta) {
          metrics.onFirstToken();
          metrics.onToken(event.delta);
        } else if (event.type === "tool_call") {
          metrics.onFirstToken();
          metrics.onToken(JSON.stringify(event.call));
        }
      }

      yield chunk;
    }
    metrics.onStreamEnd();
  } catch (error) {
    metrics.onStreamError(error as Error);
    throw error;
  }
}

/**
 * Streaming metrics toplama yardımcısı.
 * 
 * Kullanım:
 * ```typescript
 * const collector = createStreamingMetricsCollector();
 * const stream = provider.stream(request);
 * const metricsStream = withStreamingMetrics(stream, collector);
 * 
 * for await (const event of metricsStream) {
 *   // Process event
 * }
 * 
 * const metrics = collector.getMetrics();
 * console.log(`TTFB: ${metrics.ttfbMs}ms, Tokens/sec: ${metrics.tokensPerSecond}`);
 * ```
 */
export function createStreamingMetricsCollector(): StreamingMetricsCollectorImpl {
  return new StreamingMetricsCollectorImpl();
}
