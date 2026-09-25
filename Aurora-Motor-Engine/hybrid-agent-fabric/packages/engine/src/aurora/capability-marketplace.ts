import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type ListingStatus = "available" | "busy" | "deprecated";

interface CapabilityListing { id: string; tenantId: string; providerAgentId: string; name: string; description: string; category: string; tags: string[]; inputSchema: string; outputSchema: string; avgLatencyMs: number; reliability: number; costPerUse: number; usageCount: number; rating: number; reviewCount: number; status: ListingStatus; createdAt: string; }
interface CapabilityRequest { id: string; tenantId: string; requesterAgentId: string; neededCapability: string; context: string; urgency: "low" | "normal" | "high" | "critical"; matchedListingId: string; status: "open" | "matched" | "fulfilled" | "expired"; createdAt: string; }

interface MarketplaceState { schemaVersion: number; listings: CapabilityListing[]; requests: CapabilityRequest[]; }

export class CapabilityMarketplaceService {
  private store: DurableJsonState<MarketplaceState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<MarketplaceState>(
      join(baseDir, "capability-marketplace.json"),
      () => ({ schemaVersion: 1, listings: [], requests: [] }),
      (v) => { const s = v as MarketplaceState; return !!s && s.schemaVersion === 1; },
      "Aurora capability marketplace",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async listCapability(tenantId: string, providerAgentId: string, name: string, description: string, category: string, tags: string[], costPerUse: number, avgLatencyMs: number, reliability: number): Promise<CapabilityListing> {
    const l: CapabilityListing = { id: randomUUID(), tenantId, providerAgentId, name, description, category, tags, inputSchema: "", outputSchema: "", avgLatencyMs, reliability, costPerUse, usageCount: 0, rating: 0.5, reviewCount: 0, status: "available", createdAt: new Date().toISOString() };
    await this.store.mutate(s => { s.listings.push(l); });
    return l;
  }

  async searchCapabilities(tenantId: string, query: string, category?: string): Promise<CapabilityListing[]> {
    const s = await this.store.read();
    const q = query.toLowerCase();
    return s.listings.filter(l => l.tenantId === tenantId && l.status === "available" && (!category || l.category === category) && (l.name.toLowerCase().includes(q) || l.description.toLowerCase().includes(q) || l.tags.some(t => t.toLowerCase().includes(q)))).sort((a, b) => b.rating - a.rating || b.reliability - a.reliability).slice(0, 20);
  }

  async requestCapability(tenantId: string, requesterAgentId: string, neededCapability: string, context: string, urgency: CapabilityRequest["urgency"]): Promise<CapabilityRequest> {
    return await this.store.mutate(s => {
      const matches = s.listings.filter(l => l.tenantId === tenantId && l.status === "available" && (l.name.toLowerCase().includes(neededCapability.toLowerCase()) || l.tags.some(t => t.toLowerCase().includes(neededCapability.toLowerCase()))));
      const best = matches.sort((a, b) => b.rating - a.rating)[0];
      const req: CapabilityRequest = { id: randomUUID(), tenantId, requesterAgentId, neededCapability, context, urgency, matchedListingId: best?.id ?? "", status: best ? "matched" : "open", createdAt: new Date().toISOString() };
      s.requests.push(req);
      return req;
    });
  }

  async recordUsage(listingId: string): Promise<void> {
    await this.store.mutate(s => { const l = s.listings.find(x => x.id === listingId); if (l) l.usageCount++; });
  }

  async rateListing(listingId: string, rating: number): Promise<void> {
    await this.store.mutate(s => {
      const l = s.listings.find(x => x.id === listingId);
      if (!l) return;
      l.rating = (l.rating * l.reviewCount + Math.min(1, Math.max(0, rating))) / (l.reviewCount + 1);
      l.reviewCount++;
    });
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tl = s.listings.filter(l => l.tenantId === tenantId);
    const tr = s.requests.filter(r => r.tenantId === tenantId);
    const catDist: Record<string, number> = {};
    for (const l of tl) catDist[l.category] = (catDist[l.category] ?? 0) + 1;
    return { totalListings: tl.length, availableListings: tl.filter(l => l.status === "available").length, totalRequests: tr.length, fulfilledRequests: tr.filter(r => r.status === "fulfilled").length, avgRating: tl.length ? tl.reduce((sum, l) => sum + l.rating, 0) / tl.length : 0, categories: catDist };
  }

  // ═══ P2: Explainability ═══

  async why(tenantId: string, entityId: string): Promise<{
    entity: string; summary: string;
    rationale: string[]; details: Record<string, unknown>;
  }> {
    const s = await this.store.read();
    const keys = Object.keys(s);
    const arrayKey = keys.find(k => Array.isArray((s as any)[k]));
    const items: any[] = arrayKey ? ((s as any)[arrayKey] as any[]).filter((x: any) => x.tenantId === tenantId) : [];
    const entity = items.find((x: any) => x.id === entityId);
    if (!entity) throw new Error("Entity not found");
    const rationale: string[] = [`Found entity: ${entity.name ?? entity.title ?? entity.id ?? entityId}`];
    return { entity: entity.name ?? entity.title ?? entityId, summary: entity.description ?? entity.statement ?? "", rationale, details: entity };
  }
}
