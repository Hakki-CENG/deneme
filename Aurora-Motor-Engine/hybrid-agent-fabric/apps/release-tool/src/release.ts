import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SourceManifestEntry {
  path: string;
  type: "file" | "symlink";
  bytes: number;
  sha256: string;
  mode: string;
  linkTarget?: string;
}
export interface SourceManifest {
  schemaVersion: 1;
  project: { name: string; version: string };
  generatedAt: string;
  entries: SourceManifestEntry[];
  aggregateSha256: string;
}
export interface ReleasePreparationOptions {
  rootPath: string;
  outputPath: string;
  artifacts?: string[];
  sourceDateEpoch?: number;
  builderId?: string;
  signingPrivateKeyPem?: string;
}
export interface ReleasePreparationResult {
  outputPath: string;
  files: string[];
  checksums: Record<string, string>;
  signed: boolean;
}

const EXCLUDED_SEGMENTS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", "out", "target", "release", "release-metadata",
  ".cache", ".arena", ".next", ".vite", ".turbo", ".pytest_cache", "__pycache__",
]);
const SENSITIVE_NAMES = new Set([".netrc", ".npmrc", "auth.json", "secrets.json", "sessions.enc"]);

/**
 * Generated outputs that must never enter an attestation.
 *
 * These are exactly the paths `.gitignore` excludes: the eval runners rewrite
 * them on every invocation and nothing reads them back. They were being walked
 * into `source-manifest.json` anyway — 580 of 1453 attested entries were files
 * git does not track — which meant the SLSA statement covered throwaway runtime
 * state, and any `npm run eval:gates` invalidated the attestation.
 *
 * Kept as explicit paths rather than a .gitignore parser: the release tool is
 * documented to work without a git checkout. `scripts/verify-integration.mjs`
 * cross-checks the manifest against `git ls-files`, so if this list falls behind
 * .gitignore the build fails instead of silently attesting junk.
 */
const EXCLUDED_PATHS = new Set([
  "packages/eval/results/core-suite-baseline-mock.json",
  "packages/eval/results/criteria-validation.json",
  "packages/eval/results/criteria-validation.md",
  "packages/eval/results/benchmark-report.md",
  "packages/eval/results/self-improvement-report.md",
  "packages/eval/results/difficulty-analysis.md",
]);
const EXCLUDED_PREFIXES = [
  "packages/eval/results/runs/",
  "packages/eval/results/trajectories/",
  "packages/eval/results/benchmarks/",
  "packages/eval/results/costs/",
  "packages/eval/results/monitor/",
  "packages/eval/results/quality-gates/",
  "packages/eval/results/recovery/",
  "packages/eval/results/experiments/",
  "var-inbound-smoke/",
];

export async function prepareRelease(options: ReleasePreparationOptions): Promise<ReleasePreparationResult> {
  const root = await realpath(options.rootPath);
  const output = resolve(options.outputPath);
  assertInside(root, output, false);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string; version?: string };
  if (!packageJson.name || !packageJson.version) throw new Error("Root package.json name/version is required.");
  const generatedAt = sourceDate(options.sourceDateEpoch);
  const manifest = await buildSourceManifest(root, packageJson.name, packageJson.version, generatedAt);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as any;
  const cyclone = buildCycloneDx(lock, packageJson.name, packageJson.version, generatedAt, manifest.aggregateSha256);
  const spdx = buildSpdx(lock, packageJson.name, packageJson.version, generatedAt, manifest.aggregateSha256);

  await writeJson(join(output, "source-manifest.json"), manifest);
  await writeJson(join(output, "sbom.cyclonedx.json"), cyclone);
  await writeJson(join(output, "sbom.spdx.json"), spdx);

  const artifactSubjects: Array<{ name: string; digest: { sha256: string } }> = [];
  const artifactNames = new Set<string>();
  for (const artifact of options.artifacts ?? []) {
    const path = isAbsolute(artifact) ? resolve(artifact) : resolve(root, artifact);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4 * 1024 * 1024 * 1024) throw new Error(`Release artifact ${artifact} is not a bounded regular file.`);
    const name = basename(path);
    if (artifactNames.has(name)) throw new Error(`Release artifacts have a duplicate basename: ${name}.`);
    artifactNames.add(name);
    const digest = await hashFile(path);
    artifactSubjects.push({ name, digest: { sha256: digest } });
    await mkdir(join(output, "artifacts"), { recursive: true, mode: 0o700 });
    await copyFile(path, join(output, "artifacts", name));
  }
  artifactSubjects.push({ name: "source-manifest.json", digest: { sha256: await hashFile(join(output, "source-manifest.json")) } });
  artifactSubjects.sort((a, b) => a.name.localeCompare(b.name));
  const provenance = buildProvenance({
    subjects: artifactSubjects,
    generatedAt,
    builderId: options.builderId ?? `https://arena.ai/hybrid-agent-fabric/release-tool@${packageJson.version}`,
    invocationId: deterministicInvocationId(manifest.aggregateSha256, generatedAt),
    manifestSha256: manifest.aggregateSha256,
    ...(options.sourceDateEpoch !== undefined ? { sourceDateEpoch: options.sourceDateEpoch } : {}),
  });
  await atomicWrite(join(output, "provenance.intoto.jsonl"), `${canonicalJson(provenance)}\n`);

  const metadataNames = ["source-manifest.json", "sbom.cyclonedx.json", "sbom.spdx.json", "provenance.intoto.jsonl"];
  const checksums: Record<string, string> = {};
  for (const name of metadataNames) checksums[name] = await hashFile(join(output, name));
  for (const artifact of options.artifacts ?? []) {
    const path = isAbsolute(artifact) ? resolve(artifact) : resolve(root, artifact);
    checksums[`artifacts/${basename(path)}`] = await hashFile(join(output, "artifacts", basename(path)));
  }
  const sums = Object.entries(checksums).sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest}  ${name}`).join("\n") + "\n";
  await atomicWrite(join(output, "SHA256SUMS"), sums);

  let signed = false;
  if (options.signingPrivateKeyPem) {
    const envelope = signChecksums(checksums, options.signingPrivateKeyPem, generatedAt);
    await writeJson(join(output, "attestation.ed25519.json"), envelope);
    signed = true;
  }
  const files = [...metadataNames, ...[...artifactNames].sort().map((name) => `artifacts/${name}`), "SHA256SUMS", ...(signed ? ["attestation.ed25519.json"] : [])];
  return { outputPath: output, files, checksums, signed };
}

export async function verifyRelease(outputPath: string): Promise<{ valid: true; files: string[]; signature: "valid" | "absent" }> {
  const root = await realpath(outputPath);
  const sums = await readFile(join(root, "SHA256SUMS"), "utf8");
  const files: string[] = [];
  const checksums: Record<string, string> = {};
  for (const line of sums.split("\n").filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/);
    if (!match || match[2]!.includes("..") || match[2]!.startsWith("/")) throw new Error("SHA256SUMS contains an unsafe or malformed entry.");
    const name = match[2]!;
    const path = resolve(root, name); assertInside(root, path, false);
    if (await hashFile(path) !== match[1]) throw new Error(`Checksum mismatch for ${name}.`);
    files.push(name); checksums[name] = match[1]!;
  }
  let signature: "valid" | "absent" = "absent";
  try {
    const envelope = JSON.parse(await readFile(join(root, "attestation.ed25519.json"), "utf8"));
    if (!verifySignedChecksums(envelope, checksums)) throw new Error("Release attestation signature is invalid.");
    signature = "valid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { valid: true, files: files.sort(), signature };
}

export async function buildSourceManifest(root: string, name: string, version: string, generatedAt: string): Promise<SourceManifest> {
  const entries: SourceManifestEntry[] = [];
  async function walk(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const path = join(directory, child.name), rel = normalize(relative(root, path));
      if (excluded(rel, child.name)) continue;
      const info = await lstat(path);
      if (info.isDirectory()) { await walk(path); continue; }
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        entries.push({ path: rel, type: "symlink", bytes: Buffer.byteLength(target), sha256: sha256(target), mode: mode(info.mode), linkTarget: target });
      } else if (info.isFile()) {
        entries.push({ path: rel, type: "file", bytes: info.size, sha256: await hashFile(path), mode: mode(info.mode) });
      }
      if (entries.length > 100_000) throw new Error("Source manifest exceeds 100,000 entries.");
    }
  }
  await walk(root);
  const aggregateSha256 = sha256(entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""));
  return { schemaVersion: 1, project: { name, version }, generatedAt, entries, aggregateSha256 };
}

export function signChecksums(checksums: Record<string, string>, privateKeyPem: string, createdAt: string) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Release signing key must be Ed25519.");
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const payload = { schemaVersion: 1, createdAt, checksums: Object.fromEntries(Object.entries(checksums).sort(([a], [b]) => a.localeCompare(b))) };
  const bytes = Buffer.from(canonicalJson(payload));
  return {
    schemaVersion: 1,
    algorithm: "Ed25519",
    keyId: sha256(publicDer).slice(0, 32),
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    payload,
    payloadSha256: sha256(bytes),
    signature: sign(null, bytes, privateKey).toString("base64"),
  };
}

export function verifySignedChecksums(envelope: any, expectedChecksums?: Record<string, string>): boolean {
  try {
    if (envelope?.schemaVersion !== 1 || envelope?.algorithm !== "Ed25519" || typeof envelope?.publicKey !== "string" || typeof envelope?.signature !== "string") return false;
    const bytes = Buffer.from(canonicalJson(envelope.payload));
    if (sha256(bytes) !== envelope.payloadSha256) return false;
    if (expectedChecksums && canonicalJson(envelope.payload?.checksums) !== canonicalJson(Object.fromEntries(Object.entries(expectedChecksums).sort(([a], [b]) => a.localeCompare(b))))) return false;
    const publicKey = createPublicKey(envelope.publicKey);
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    if (sha256(der).slice(0, 32) !== envelope.keyId) return false;
    return verify(null, bytes, publicKey, Buffer.from(envelope.signature, "base64"));
  } catch { return false; }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function buildCycloneDx(lock: any, rootName: string, rootVersion: string, generatedAt: string, manifestSha256: string) {
  const components = lockComponents(lock).map((item) => ({
    type: "library", "bom-ref": item.purl, name: item.name, version: item.version, purl: item.purl,
    ...(item.license ? { licenses: [{ license: { id: item.license } }] } : {}),
    properties: [{ name: "haf:lockPath", value: item.path }],
  }));
  return {
    bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
    metadata: {
      timestamp: generatedAt,
      component: { type: "application", "bom-ref": `pkg:npm/${encodePurl(rootName)}@${rootVersion}`, name: rootName, version: rootVersion },
      properties: [{ name: "haf:sourceManifestSha256", value: manifestSha256 }],
    },
    components,
  };
}

function buildSpdx(lock: any, rootName: string, rootVersion: string, generatedAt: string, manifestSha256: string) {
  const items = lockComponents(lock);
  return {
    spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
    name: `${rootName}-${rootVersion}`, documentNamespace: `https://arena.ai/spdx/${encodeURIComponent(rootName)}/${rootVersion}/${manifestSha256}`,
    creationInfo: { created: generatedAt, creators: [`Tool: haf-release-${rootVersion}`] },
    packages: [
      { name: rootName, SPDXID: "SPDXRef-Root", versionInfo: rootVersion, downloadLocation: "NOASSERTION", filesAnalyzed: false, checksums: [{ algorithm: "SHA256", checksumValue: manifestSha256 }] },
      ...items.map((item, index) => ({
        name: item.name, SPDXID: `SPDXRef-Package-${index + 1}`, versionInfo: item.version,
        downloadLocation: "NOASSERTION", filesAnalyzed: false,
        licenseConcluded: item.license ?? "NOASSERTION", licenseDeclared: item.license ?? "NOASSERTION",
        externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: item.purl }],
      })),
    ],
    relationships: items.map((_item, index) => ({ spdxElementId: "SPDXRef-Root", relationshipType: "DEPENDS_ON", relatedSpdxElement: `SPDXRef-Package-${index + 1}` })),
  };
}

function buildProvenance(input: { subjects: Array<{ name: string; digest: { sha256: string } }>; generatedAt: string; builderId: string; invocationId: string; manifestSha256: string; sourceDateEpoch?: number }) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: input.subjects,
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://arena.ai/hybrid-agent-fabric/build/v1",
        externalParameters: { sourceDateEpoch: input.sourceDateEpoch ?? null },
        internalParameters: {},
        resolvedDependencies: [
          { uri: "git+https://github.com/OpenHands/OpenHands@c41bda23d6b648bf3a30422ab9d71bd7675caea1" },
          { uri: "git+https://github.com/PrimeIntellect-ai/prime-agent@e85a67ac4ad7fef2f2a5b922a78fcede85786ac7" },
          { uri: "git+https://github.com/NousResearch/hermes-agent@77d6c78cf52ec9f2c3245174cf763ff32a75d572" },
          { uri: `urn:sha256:${input.manifestSha256}` },
        ],
      },
      runDetails: {
        builder: { id: input.builderId },
        metadata: { invocationId: input.invocationId, startedOn: input.generatedAt, finishedOn: input.generatedAt },
      },
    },
  };
}

function lockComponents(lock: any): Array<{ path: string; name: string; version: string; purl: string; license?: string }> {
  const output: Array<{ path: string; name: string; version: string; purl: string; license?: string }> = [];
  for (const [path, value] of Object.entries(lock?.packages ?? {}) as Array<[string, any]>) {
    if (!path || !value || typeof value !== "object" || typeof value.version !== "string") continue;
    const name = typeof value.name === "string" ? value.name : packageNameFromPath(path);
    if (!name) continue;
    output.push({ path, name, version: value.version, purl: `pkg:npm/${encodePurl(name)}@${encodeURIComponent(value.version)}`, ...(typeof value.license === "string" ? { license: value.license } : {}) });
  }
  return output.sort((a, b) => a.purl.localeCompare(b.purl) || a.path.localeCompare(b.path));
}

function packageNameFromPath(path: string): string | undefined {
  const marker = "node_modules/", index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  return path.slice(index + marker.length);
}
function encodePurl(name: string): string { return name.startsWith("@") ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}` : encodeURIComponent(name); }
function excluded(rel: string, name: string): boolean {
  const segments = rel.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)) || segments[0] === "var") return true;
  if (EXCLUDED_PATHS.has(rel)) return true;
  if (EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) return true;
  if (SENSITIVE_NAMES.has(name)) return true;
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;
  if (name.endsWith(".tsbuildinfo") || name.endsWith(".pem") || name.endsWith(".key")) return true;
  return false;
}
function mode(value: number): string { return `0${(value & 0o777).toString(8).padStart(3, "0")}`; }
function normalize(value: string): string { return value.split(sep).join("/"); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function hashFile(path: string): Promise<string> { return sha256(await readFile(path)); }
function sourceDate(epoch?: number): string {
  const value = epoch ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(value) || value < 0 || value > 253402300799) throw new Error("SOURCE_DATE_EPOCH is invalid.");
  return new Date(value * 1000).toISOString();
}
function deterministicInvocationId(manifest: string, time: string): string {
  const hex = sha256(`${manifest}\0${time}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function assertInside(root: string, target: string, allowEqual: boolean): void {
  const rel = relative(root, target);
  if ((!allowEqual && !rel) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Release output/path escapes the project root.");
}
async function writeJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`); }
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}
