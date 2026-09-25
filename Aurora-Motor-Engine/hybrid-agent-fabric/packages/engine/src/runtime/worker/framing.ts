export interface WorkerFrameHeader {
  type: string;
  requestId?: string;
  generation?: number;
  sequence?: number;
  [key: string]: unknown;
}

export interface WorkerFrame {
  header: WorkerFrameHeader;
  payload: Buffer;
}

const PREFIX_BYTES = 8;
export const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export function encodeWorkerFrame(header: WorkerFrameHeader, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const payloadBytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  if (headerBytes.length > DEFAULT_MAX_HEADER_BYTES) throw new Error("Worker frame header is too large.");
  if (payloadBytes.length > DEFAULT_MAX_PAYLOAD_BYTES) throw new Error("Worker frame payload is too large.");
  const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
  prefix.writeUInt32BE(headerBytes.length, 0);
  prefix.writeUInt32BE(payloadBytes.length, 4);
  return Buffer.concat([prefix, headerBytes, payloadBytes]);
}

export class WorkerFrameDecoder {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(
    private readonly maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
    private readonly maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  ) {}

  push(chunk: Buffer): WorkerFrame[] {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    const output: WorkerFrame[] = [];
    while (this.buffered.length >= PREFIX_BYTES) {
      const headerLength = this.buffered.readUInt32BE(0);
      const payloadLength = this.buffered.readUInt32BE(4);
      if (headerLength > this.maxHeaderBytes) throw new Error(`Worker frame header exceeds ${this.maxHeaderBytes} bytes.`);
      if (payloadLength > this.maxPayloadBytes) throw new Error(`Worker frame payload exceeds ${this.maxPayloadBytes} bytes.`);
      const total = PREFIX_BYTES + headerLength + payloadLength;
      if (this.buffered.length < total) break;
      const headerBytes = this.buffered.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength);
      const payload = this.buffered.subarray(PREFIX_BYTES + headerLength, total);
      let header: WorkerFrameHeader;
      try {
        header = JSON.parse(headerBytes.toString("utf8")) as WorkerFrameHeader;
      } catch {
        throw new Error("Worker frame contains an invalid JSON header.");
      }
      if (!header || typeof header.type !== "string") throw new Error("Worker frame header has no type.");
      output.push({ header, payload: Buffer.from(payload) });
      this.buffered = this.buffered.subarray(total);
    }
    return output;
  }

  reset(): void {
    this.buffered = Buffer.alloc(0);
  }
}
