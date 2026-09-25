import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { auroraDigest, auroraInteger, auroraText } from "../util/aurora-state.js";

/** Lowest precedence first. `managed` is last on purpose: it is the floor nothing may relax. */
export const SETTING_LAYERS = ["defaults", "user", "project", "project-local", "runtime", "managed"] as const;
export type SettingLayer = (typeof SETTING_LAYERS)[number];

const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_KEYS = 200;

export interface SettingValue {
  key: string;
  value: unknown;
  /** The layer that produced the effective value. */
  layer: SettingLayer;
  /** True when the managed layer set it: no lower layer, project file or flag can change it. */
  locked: boolean;
  /** Every layer that had an opinion, lowest precedence first. */
  contributions: Array<{ layer: SettingLayer; value: unknown; overridden: boolean }>;
}

export interface EffectiveSettings {
  tenantId: string;
  values: Record<string, unknown>;
  provenance: SettingValue[];
  locked: string[];
  layersPresent: SettingLayer[];
  sources: Array<{ layer: SettingLayer; source: string; keys: number; digest: string }>;
  warnings: string[];
  generatedAt: string;
}

export interface SettingsInput {
  defaults?: Record<string, unknown>;
  user?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

/**
 * Layered settings with provenance, and a managed layer that is an actual floor.
 *
 * Aurora's governance was always strong per tenant, but it could not answer two questions an enterprise
 * asks immediately: *which layer made this setting what it is?* and *can a developer relax it?* Peers
 * answer both with a precedence tree topped by an administrator-controlled managed layer that no flag,
 * project file or personal override can loosen.
 *
 * This resolver does the same, with the properties Aurora insists on elsewhere:
 *
 * - the merge order is fixed and published, and every effective value carries the layer that produced
 *   it *plus every layer that had an opinion*, so "why is this off?" is answered from data;
 * - a key set by the managed layer is `locked`. Lower layers may still declare it — the declaration is
 *   recorded as overridden rather than dropped silently, because a developer deserves to see that their
 *   setting exists and is being ignored;
 * - arrays concatenate and de-duplicate except under `managed`, where the managed list replaces
 *   everything: a deny list an admin controls must not be extendable *or* shrinkable from below;
 * - project files are untrusted repository content: bounded size, bounded key count, parse failures
 *   become warnings rather than exceptions, and nothing about them can raise authority.
 */
export class SettingsResolver {
  constructor(
    private readonly deps: {
      /** Absolute path to the enterprise managed settings file, if the deployment has one. */
      managedPath?: string | undefined;
      now?: () => number;
    } = {},
  ) {}

  async effective(input: { tenantId: string; workspacePath?: string; settings?: SettingsInput }): Promise<EffectiveSettings> {
    const tenantId = auroraText(input.tenantId, 200, "Tenant ID");
    const now = this.deps.now?.() ?? Date.now();
    const warnings: string[] = [];
    const sources: EffectiveSettings["sources"] = [];
    const layers = new Map<SettingLayer, Record<string, unknown>>();

    const record = (layer: SettingLayer, source: string, value: Record<string, unknown> | undefined): void => {
      if (!value || !Object.keys(value).length) return;
      const bounded = this.bound(layer, value, warnings);
      layers.set(layer, bounded);
      sources.push({ layer, source, keys: Object.keys(bounded).length, digest: auroraDigest(bounded).slice(0, 16) });
    };

    record("defaults", "engine", input.settings?.defaults);
    record("user", "tenant", input.settings?.user);
    if (input.workspacePath) {
      record("project", ".aurora/settings.json", await this.readJson(join(input.workspacePath, ".aurora", "settings.json"), warnings));
      record("project-local", ".aurora/settings.local.json", await this.readJson(join(input.workspacePath, ".aurora", "settings.local.json"), warnings));
    }
    record("runtime", "flags/environment", input.settings?.runtime);
    if (this.deps.managedPath) {
      record("managed", this.deps.managedPath, await this.readJson(this.deps.managedPath, warnings));
    }

    const keys = new Set<string>();
    for (const value of layers.values()) for (const key of Object.keys(value)) keys.add(key);

    const provenance: SettingValue[] = [];
    const values: Record<string, unknown> = {};
    const locked: string[] = [];

    for (const key of [...keys].sort()) {
      const contributions: SettingValue["contributions"] = [];
      let effective: unknown;
      let effectiveLayer: SettingLayer = "defaults";
      const managed = layers.get("managed");
      const managedHasKey = managed !== undefined && Object.hasOwn(managed, key);

      for (const layer of SETTING_LAYERS) {
        const layerValues = layers.get(layer);
        if (!layerValues || !Object.hasOwn(layerValues, key)) continue;
        const value = layerValues[key];
        contributions.push({ layer, value, overridden: false });
        if (managedHasKey && layer !== "managed") continue; // recorded, then ignored: the floor wins
        if (Array.isArray(value) && Array.isArray(effective) && layer !== "managed") {
          effective = [...new Set([...(effective as unknown[]), ...value])];
        } else {
          effective = value;
        }
        effectiveLayer = layer;
      }

      for (const contribution of contributions) {
        contribution.overridden = contribution.layer !== effectiveLayer
          && !(Array.isArray(effective) && !managedHasKey && Array.isArray(contribution.value));
      }

      values[key] = effective;
      if (managedHasKey) locked.push(key);
      provenance.push({ key, value: effective, layer: effectiveLayer, locked: managedHasKey, contributions });
    }

    return {
      tenantId,
      values,
      provenance,
      locked,
      layersPresent: SETTING_LAYERS.filter((layer) => layers.has(layer)),
      sources,
      warnings,
      generatedAt: new Date(now).toISOString(),
    };
  }

  /** Convenience for enforcement points: a single value plus whether an administrator locked it. */
  async value<T>(input: { tenantId: string; workspacePath?: string; settings?: SettingsInput; key: string }): Promise<{ value: T | undefined; layer: SettingLayer | undefined; locked: boolean }> {
    const effective = await this.effective(input);
    const entry = effective.provenance.find((item) => item.key === input.key);
    return { value: entry?.value as T | undefined, layer: entry?.layer, locked: entry?.locked ?? false };
  }

  private bound(layer: SettingLayer, value: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
    const entries = Object.entries(value).filter(([key]) => /^[a-zA-Z][a-zA-Z0-9._-]{0,100}$/.test(key));
    if (entries.length !== Object.keys(value).length) warnings.push(`${layer}: ignored setting keys with invalid names.`);
    if (entries.length > MAX_KEYS) {
      warnings.push(`${layer}: only the first ${MAX_KEYS} settings were read.`);
      entries.length = MAX_KEYS;
    }
    return Object.fromEntries(entries);
  }

  private async readJson(path: string, warnings: string[]): Promise<Record<string, unknown> | undefined> {
    const target = resolve(path);
    if (!isAbsolute(target)) return undefined;
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch {
      return undefined;
    }
    if (Buffer.byteLength(raw) > MAX_SETTINGS_BYTES) {
      warnings.push(`${target}: settings file exceeds ${auroraInteger(MAX_SETTINGS_BYTES, 1, 10_000_000, "Settings size")} bytes and was ignored.`);
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`${target}: settings must be a JSON object; the file was ignored.`);
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch {
      // A malformed project settings file is a warning, never a broken session.
      warnings.push(`${target}: settings file is not valid JSON and was ignored.`);
      return undefined;
    }
  }
}

/** Keys the engine actually enforces. Anything else is carried through for callers to interpret. */
export const ENFORCED_SETTING_KEYS = {
  /** Highest permission mode a session may select. `session.mode.set` refuses to exceed it. */
  permissionModeCeiling: "permissionModeCeiling",
  /** Capability ids an administrator forbids outright. */
  deniedCapabilities: "deniedCapabilities",
  /** Whether `bypass` may be enabled at all in this deployment. */
  allowBypass: "allowBypass",
} as const;
