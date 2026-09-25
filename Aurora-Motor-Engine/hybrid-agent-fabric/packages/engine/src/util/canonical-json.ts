/**
 * Canonical JSON serialisation.
 *
 * Two modules already had their own private copy of this, and both needed it
 * for the same reason: a hash or a signature over an object must not depend on
 * the order its keys happened to be inserted in.
 *
 * The trap this avoids, recorded because it was hit: `JSON.stringify(value,
 * arrayOfKeys)` uses the array as a *filter* at every level of nesting, so
 * passing the top-level names silently drops every nested field. An extension
 * manifest signed that way carried no entrypoint, which meant editing the
 * entrypoint did not break the signature.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
