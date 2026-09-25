import { describe, expect, it } from "vitest";
import { isAllowedArtifactFrameUrl } from "../src/security.js";

describe("desktop artifact frame navigation", () => {
  it("allows only same-origin artifact frame paths", () => {
    const origin = "https://haf.example";
    expect(isAllowedArtifactFrameUrl("https://haf.example/v1/artifacts/123e4567-e89b-12d3-a456-426614174000/frame?channel=x", origin)).toBe(true);
    expect(isAllowedArtifactFrameUrl("https://evil.example/v1/artifacts/123e4567-e89b-12d3-a456-426614174000/frame", origin)).toBe(false);
    expect(isAllowedArtifactFrameUrl("https://haf.example/canvas/", origin)).toBe(false);
    expect(isAllowedArtifactFrameUrl("javascript:alert(1)", origin)).toBe(false);
  });
});
