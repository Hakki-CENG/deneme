export function isAllowedArtifactFrameUrl(url: string, targetOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === targetOrigin && /^\/v1\/artifacts\/[a-f0-9-]+\/frame$/i.test(parsed.pathname);
  } catch { return false; }
}
