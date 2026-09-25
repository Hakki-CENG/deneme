import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

type TradeStatus = "offered" | "accepted" | "completed" | "disputed" | "cancelled";
type ResourceType = "cpu" | "memory" | "storage" | "model_credits" | "skill_access" | "data" | "attention";

interface Trade { id: string; tenantId: string; fromAgentId: string; toAgentId: string; offeredResource: ResourceType; offeredAmount: number; requestedResource: ResourceType; requestedAmount: number; status: TradeStatus; satisfaction: number; createdAt: string; completedAt: string; }
interface AgentWallet { agentId: string; tenantId: string; balance: Record<ResourceType, number>; totalEarned: number; totalSpent: number; tradeCount: number; reputation: number; lastActivityAt: string; }

interface EconomyState { schemaVersion: number; wallets: AgentWallet[]; trades: Trade[]; }

export class AgentEconomyService {
  private store: DurableJsonState<EconomyState>;
  constructor(private baseDir: string) {
    this.store = new DurableJsonState<EconomyState>(
      join(baseDir, "agent-economy.json"),
      () => ({ schemaVersion: 1, wallets: [], trades: [] }),
      (v) => { const s = v as EconomyState; return !!s && s.schemaVersion === 1; },
      "Aurora agent economy",
    );
  }
  async init(): Promise<void> { await this.store.read(); }

  async getOrCreateWallet(tenantId: string, agentId: string): Promise<AgentWallet> {
    return await this.store.mutate(s => {
      let w = s.wallets.find(x => x.agentId === agentId && x.tenantId === tenantId);
      if (w) return w;
      w = { agentId, tenantId, balance: { cpu: 100, memory: 100, storage: 50, model_credits: 500, skill_access: 20, data: 30, attention: 40 }, totalEarned: 0, totalSpent: 0, tradeCount: 0, reputation: 0.5, lastActivityAt: new Date().toISOString() };
      s.wallets.push(w);
      return w;
    });
  }

  async offerTrade(tenantId: string, fromAgentId: string, toAgentId: string, offer: { resource: ResourceType; amount: number }, request: { resource: ResourceType; amount: number }): Promise<Trade> {
    const trade: Trade = { id: randomUUID(), tenantId, fromAgentId, toAgentId, offeredResource: offer.resource, offeredAmount: offer.amount, requestedResource: request.resource, requestedAmount: request.amount, status: "offered", satisfaction: 0, createdAt: new Date().toISOString(), completedAt: "" };
    await this.store.mutate(s => { s.trades.push(trade); });
    return trade;
  }

  async acceptTrade(tradeId: string): Promise<boolean> {
    return await this.store.mutate(s => {
      const trade = s.trades.find(t => t.id === tradeId);
      if (!trade || trade.status !== "offered") return false;
      const from = s.wallets.find(w => w.agentId === trade.fromAgentId);
      const to = s.wallets.find(w => w.agentId === trade.toAgentId);
      if (!from || !to) return false;
      if ((from.balance[trade.offeredResource] ?? 0) < trade.offeredAmount) return false;
      if ((to.balance[trade.requestedResource] ?? 0) < trade.requestedAmount) return false;
      from.balance[trade.offeredResource] = (from.balance[trade.offeredResource] ?? 0) - trade.offeredAmount;
      from.balance[trade.requestedResource] = (from.balance[trade.requestedResource] ?? 0) + trade.requestedAmount;
      to.balance[trade.requestedResource] = (to.balance[trade.requestedResource] ?? 0) - trade.requestedAmount;
      to.balance[trade.offeredResource] = (to.balance[trade.offeredResource] ?? 0) + trade.offeredAmount;
      trade.status = "accepted";
      trade.satisfaction = 0.8;
      trade.completedAt = new Date().toISOString();
      from.tradeCount++; to.tradeCount++;
      from.totalSpent += trade.offeredAmount;
      to.totalEarned += trade.requestedAmount;
      return true;
    });
  }

  async getTrades(tenantId: string, limit = 30): Promise<Trade[]> {
    const s = await this.store.read();
    return s.trades.filter(t => t.tenantId === tenantId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tw = s.wallets.filter(w => w.tenantId === tenantId);
    const tt = s.trades.filter(t => t.tenantId === tenantId);
    const accepted = tt.filter(t => t.status === "accepted").length;
    return { totalAgents: tw.length, totalTrades: tt.length, completedTrades: accepted, avgReputation: tw.length ? tw.reduce((sum, w) => sum + w.reputation, 0) / tw.length : 0, avgTradeSatisfaction: accepted ? tt.filter(t => t.status === "accepted").reduce((sum, t) => sum + t.satisfaction, 0) / accepted : 0, wallets: tw.map(w => ({ agentId: w.agentId, balance: w.balance, reputation: w.reputation })) };
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
