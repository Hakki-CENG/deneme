import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../types.js";
import type { ModelOAuthManager } from "./model-oauth-manager.js";
import { ModelProviderError } from "./model-provider-error.js";

export interface OAuthBearerModelProviderOptions {
  id: string;
  tenantId: string;
  sourceId: string;
  resourceOrigin: string;
  oauth: ModelOAuthManager;
  build: (accessToken: string) => ModelProvider;
}

/** Materializes a fresh same-source provider per request and retries one pre-output credential rejection. */
export class OAuthBearerModelProvider implements ModelProvider {
  readonly id: string;
  constructor(private readonly options: OAuthBearerModelProviderOptions) { this.id = options.id; }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.tenantId !== this.options.tenantId) throw new Error("OAuth model route tenant mismatch.");
    let auth = await this.options.oauth.authorization(this.options.sourceId, this.options.tenantId, this.options.resourceOrigin);
    for (let attempt = 0; attempt < 2; attempt++) {
      let emitted = false;
      try {
        for await (const event of this.options.build(auth.accessToken).stream(request)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        const rejected = error instanceof ModelProviderError && (error.status === 401 || error.status === 403 || error.code === "credential_rejected");
        if (attempt === 0 && !emitted && rejected) {
          auth = await this.options.oauth.forceRefresh(this.options.sourceId, this.options.tenantId, this.options.resourceOrigin);
          continue;
        }
        throw error;
      }
    }
  }
}
