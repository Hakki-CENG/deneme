import { gunzipSync } from "node:zlib";

/**
 * P1.34 archive safety: a minimal tar/tgz reader that refuses everything an
 * archive must never be allowed to do to a workspace.
 *
 * Tar is a dangerous format to accept naively: entries can carry absolute
 * paths, `../` traversal, symlinks that later writes follow, device nodes and
 * fifos. This parser accepts only regular files and directories from
 * POSIX/GNU tar archives, rejects every other entry type, and enforces entry
 * count, per-entry and total size ceilings before a single byte is written.
 *
 * It is deliberately small rather than complete: unsupported features (GNU
 * long names, pax headers, hard links) are rejected with a reason instead of
 * being interpreted hopefully.
 */

export interface SafeTarEntry {
  path: string;
  bytes: Buffer;
}

export interface SafeTarLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_SAFE_TAR_LIMITS: SafeTarLimits = {
  maxEntries: 5_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

/** Detect and inflate gzip (magic 1f 8b) before tar parsing. */
export function inflateIfGzip(buffer: Buffer): Buffer {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return gunzipSync(buffer);
  return buffer;
}

function parseOctal(field: Buffer): number {
  const text = field.toString("utf8").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("Tar header size field is not octal.");
  return parseInt(text, 8);
}

/** A path is archive-safe when it stays inside the extraction root. */
export function isSafeEntryPath(path: string): boolean {
  if (!path || path.length > 300) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  if (path.includes("\0")) return false;
  const segments = path.split(/[/\\]/);
  return segments.every((segment) => segment !== ".." && segment !== "." && segment !== "");
}

/**
 * Parse a tar buffer into regular-file entries. Directories are recorded as
 * their children's paths; anything else — symlink, hardlink, char/block
 * device, fifo, GNU long name — is a refusal.
 */
export function parseSafeTar(input: Buffer, limits: SafeTarLimits = DEFAULT_SAFE_TAR_LIMITS): SafeTarEntry[] {
  const buffer = inflateIfGzip(input);
  if (buffer.length === 0) return [];
  const entries: SafeTarEntry[] = [];
  let total = 0;
  let offset = 0;
  let seenZeroBlock = false;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      seenZeroBlock = true;
      offset += 512;
      continue;
    }
    if (seenZeroBlock) {
      // Data after a terminator block: a malformed or hand-crafted archive.
      throw new Error("Tar archive has data after its end-of-archive block.");
    }
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const size = parseOctal(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const magic = header.toString("utf8", 257, 263).replace(/\0.*$/, "").trim();
    if (magic && !magic.startsWith("ustar")) throw new Error(`Tar archive has an unrecognized format magic "${magic}".`);
    if (name === "././@LongLink") throw new Error("GNU long-name tar entries are not supported.");
    if (!isSafeEntryPath(name)) throw new Error(`Tar entry "${name.slice(0, 200)}" escapes the extraction root.`);
    if (size < 0 || size > limits.maxEntryBytes) throw new Error(`Tar entry "${name.slice(0, 200)}" exceeds the per-entry size limit.`);
    if (total + size > limits.maxTotalBytes) throw new Error("Tar archive exceeds the total extraction size limit.");
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    if (data.length < size) throw new Error("Tar archive is truncated: entry data extends past the buffer.");
    if (typeFlag === "5") {
      // Directory entry: nothing to write; children carry the paths.
    } else if (typeFlag === "0" || typeFlag === "\0") {
      entries.push({ path: name, bytes: Buffer.from(data) });
      total += size;
      if (entries.length > limits.maxEntries) throw new Error("Tar archive exceeds the entry count limit.");
    } else {
      throw new Error(`Tar entry "${name.slice(0, 200)}" has unsupported type "${typeFlag}" (only regular files and directories are extracted).`);
    }
    // Entries are padded to 512-byte boundaries.
    offset += 512 + size + ((512 - (size % 512)) % 512);
  }
  if (offset < buffer.length && buffer.length - offset < 512) {
    // Trailing partial block: tolerate tar's short final padding.
    const tail = buffer.subarray(offset);
    if (!tail.every((byte) => byte === 0)) throw new Error("Tar archive ends with a partial non-padding block.");
  }
  return entries;
}
