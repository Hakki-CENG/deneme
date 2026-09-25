import type { JsonValue, ModelProvider, ModelRequest, ModelStreamEvent } from "../types.js";
import { classifyModelFailure } from "./model-provider-error.js";

interface ProviderWithStatus extends ModelProvider {
  status?: () => JsonValue;
  reset?: (credentialId?: string) => Promise<JsonValue>;
}

export interface ModelRouteStatus {
  id: string;
  detail?: JsonValue;
}

function splitModelRoute(route: string | undefined): { providerId?: string; model?: string } {
  if (!route?.includes(":")) return route ? { model: route } : {};
  const separator = route.indexOf(":");
  return { providerId: route.slice(0, separator), model: route.slice(separator + 1) };
}

/**
 * The registry of model providers this engine can actually call.
 *
 * Renamed from `ModelRouter`, which collided in name -- though not in purpose --
 * with `ModelRoutingPipeline` in `routing/model-routing.ts`. One is a registry of
 * what exists; the other scores and picks. The shared name cost real time: a call
 * to `this.models.selectModel(...)` type-checks against the wrong class in the
 * reader's head and fails against the right one in the compiler.
 *
 * It is itself a `ModelProvider`: it dispatches to whichever provider is
 * registered for the requested route.
 */
export class ModelProviderRegistry implements ModelProvider {
  readonly id = "router";
  private readonly providers = new Map<string, ModelProvider>();
  private defaultProviderId?: string;
  /**
   * P2.32: where each provider physically runs. Undeclared means "cloud" on
   * purpose — for a privacy constraint the safe assumption about an unknown
   * provider is that data would leave the device, not that it would stay.
   */
  private readonly locality = new Map<string, "local" | "cloud">();

  register(provider: ModelProvider, makeDefault = false): void {
    if (this.providers.has(provider.id)) throw new Error(`Model provider ${provider.id} is already registered.`);
    this.providers.set(provider.id, provider);
    if (makeDefault || !this.defaultProviderId) this.defaultProviderId = provider.id;
  }

  /** P2.32: declare where a provider runs. The engine applies this from config. */
  setLocality(providerId: string, where: "local" | "cloud"): void {
    if (!this.providers.has(providerId)) throw new Error(`Model provider ${providerId} is not registered.`);
    this.locality.set(providerId, where);
  }

  getLocality(providerId: string): "local" | "cloud" {
    return this.locality.get(providerId) ?? "cloud";
  }

  private providerIdOf(route: string): string {
    return splitModelRoute(route).providerId ?? this.defaultProviderId ?? route;
  }

  unregister(providerId: string): boolean {
    if (providerId === this.defaultProviderId) throw new Error("The default model provider cannot be unregistered while the engine is running.");
    return this.providers.delete(providerId);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  status(): ModelRouteStatus[] {
    return [...this.providers.values()].map((provider) => {
      const detail = (provider as ProviderWithStatus).status?.();
      return { id: provider.id, ...(detail !== undefined ? { detail } : {}) };
    });
  }

  async resetCredentialPool(providerId: string, credentialId?: string): Promise<JsonValue> {
    const provider = this.providers.get(providerId) as ProviderWithStatus | undefined;
    if (!provider) throw new Error(`Model provider ${providerId} is not registered.`);
    if (!provider.reset) throw new Error(`Model provider ${providerId} does not expose a credential pool.`);
    return await provider.reset(credentialId);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const routes = [request.model, ...(request.fallbackModels ?? [])]
      .filter((route): route is string => Boolean(route?.trim()));
    if (routes.length === 0) routes.push("");

    const seen = new Set<string>();
    let candidates = routes.filter((route) => {
      if (seen.has(route)) return false;
      seen.add(route);
      return true;
    });

    // P2.32 device-aware routing. "local-only" keeps only providers declared
    // local — undeclared counts as cloud. When the constraint empties the
    // candidate list the error says so; silently falling back to a cloud
    // provider would defeat the point of the constraint. "prefer-local"
    // reorders so local providers are tried first, cloud stays as fallback.
    if (request.privacy === "local-only" || request.privacy === "prefer-local") {
      const localityScore = (route: string) => (this.getLocality(this.providerIdOf(route)) === "local" ? 0 : 1);
      const ordered = [...candidates].sort((a, b) => localityScore(a) - localityScore(b));
      if (request.privacy === "local-only") {
        candidates = ordered.filter((route) => localityScore(route) === 0);
        if (candidates.length === 0) {
          const local = [...this.providers.keys()].filter((id) => this.getLocality(id) === "local");
          throw new Error(
            local.length === 0
              ? "No local model provider is configured; a local-only request cannot be served and was not sent to any cloud provider."
              : `The requested routes are all cloud providers; a local-only request only accepts: ${local.join(", ")}.`,
          );
        }
      } else {
        candidates = ordered;
      }
    }
    let lastFailure: Error | undefined;

    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const route = candidates[attempt]!;
      const parsed = splitModelRoute(route);
      const providerId = parsed.providerId ?? this.defaultProviderId ?? route;
      const provider = this.providers.get(providerId);
      if (!provider) {
        lastFailure = new Error(`No model provider configured for ${providerId || "default"}.`);
        if (attempt + 1 < candidates.length) continue;
        throw lastFailure;
      }

      const selectedRoute = parsed.providerId ? route : parsed.model ? `${provider.id}:${parsed.model}` : provider.id;
      yield {
        type: "route_selected",
        provider: provider.id,
        model: parsed.model ?? "default",
        attempt,
        fallback: attempt > 0,
      };
      let producedProviderOutput = false;
      try {
        for await (const event of provider.stream({ ...request, model: selectedRoute, fallbackModels: [] })) {
          producedProviderOutput = true;
          yield event;
        }
        return;
      } catch (error) {
        const failure = classifyModelFailure(provider.id, error);
        lastFailure = failure;
        if (producedProviderOutput || failure.code === "cancelled") throw failure;
        yield {
          type: "route_failed",
          provider: provider.id,
          model: parsed.model ?? "default",
          attempt,
          code: failure.code,
          retryable: failure.retryable,
        };
        if (attempt + 1 >= candidates.length) throw failure;
      }
    }
    throw lastFailure ?? new Error("No model route was available.");
  }
}

/**
 * @deprecated Use `ModelProviderRegistry`. Kept so existing imports and
 * published type references keep working; it is the same class, not a wrapper.
 */
export const ModelRouter = ModelProviderRegistry;
export type ModelRouter = ModelProviderRegistry;
