import { z } from "zod";
import type { HostedRepositoryProviderRegistry } from "../repositories/hosted-repository-provider.js";
import { defineCapability } from "./schema.js";

export function hostedReviewCapabilities(registry: HostedRepositoryProviderRegistry) {
  const location = {
    providerId: z.string().uuid(),
    repositoryId: z.string().min(1).max(100),
    reviewNumber: z.number().int().min(1).max(1_000_000_000),
  };
  return [
    defineCapability(
      { id: "repository.review.create", version: "1.0.0", description: "Create a GitHub pull request or GitLab merge request from existing remote branches. This is an external side effect.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ providerId: location.providerId, repositoryId: location.repositoryId, title: z.string().min(1).max(300), body: z.string().max(100_000).optional(), sourceBranch: z.string().min(1).max(200), targetBranch: z.string().min(1).max(200), draft: z.boolean().default(false) }),
      async (input, context) => await registry.createReview({
        tenantId: context.tenantId, idempotencyKey: context.idempotencyKey,
        providerId: input.providerId, repositoryId: input.repositoryId, title: input.title,
        sourceBranch: input.sourceBranch, targetBranch: input.targetBranch, draft: input.draft,
        ...(input.body ? { body: input.body } : {}),
      }),
    ),
    defineCapability(
      { id: "repository.review.comment", version: "1.0.0", description: "Add a bounded comment to a hosted pull/merge request. This is an external side effect.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ ...location, body: z.string().min(1).max(100_000) }),
      async (input, context) => await registry.commentReview({ tenantId: context.tenantId, idempotencyKey: context.idempotencyKey, ...input }),
    ),
    defineCapability(
      { id: "repository.review.close", version: "1.0.0", description: "Close a hosted pull/merge request without deleting its branch. This is an external side effect.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object(location),
      async (input, context) => await registry.closeReview({ tenantId: context.tenantId, idempotencyKey: context.idempotencyKey, ...input }),
    ),
    defineCapability(
      { id: "repository.review.merge", version: "1.0.0", description: "Merge a hosted pull/merge request only if its remote HEAD matches the supplied SHA. This is an external side effect requiring approval.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ ...location, expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i), method: z.enum(["merge", "squash", "rebase"]).default("merge") }),
      async (input, context) => await registry.mergeReview({ tenantId: context.tenantId, idempotencyKey: context.idempotencyKey, ...input }),
    ),
  ];
}
