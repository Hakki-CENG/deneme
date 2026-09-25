/**
 * Context Engineering — Aurora Cognitive Runtime
 *
 * Tool discovery (sadece gerekli tool'ları göster).
 * Minimal context prensibi.
 * Context optimization.
 */

import { randomUUID } from "node:crypto";

/**
 * Context relevance score.
 * 
 * Her context item için relevance score hesaplanır.
 */
export interface ContextItem {
  id: string;
  type: "tool" | "memory" | "skill" | "knowledge" | "instruction";
  content: string;
  relevanceScore: number;
  priority: number;
  charCount: number;
  source: string;
  metadata?: Record<string, unknown>;
}

/**
 * Context budget.
 * 
 * Toplam context boyutunu sınırlar.
 */
export interface ContextBudget {
  maxChars: number;
  maxItems: number;
  maxTools: number;
  maxMemories: number;
  maxSkills: number;
}

/**
 * Context optimization result.
 */
export interface ContextOptimizationResult {
  /** Seçilen context item'ları */
  selected: ContextItem[];
  /** Atlanan context item'ları */
  omitted: ContextItem[];
  /** Toplam karakter sayısı */
  totalChars: number;
  /** Toplam item sayısı */
  totalItems: number;
  /** Optimizasyon istatistikleri */
  stats: {
    originalItems: number;
    selectedItems: number;
    omittedItems: number;
    originalChars: number;
    selectedChars: number;
    omittedChars: number;
    compressionRatio: number;
  };
}

/**
 * Tool Discovery Engine
 * 
 * Sadece gerekli tool'ları gösterir.
 * Task'a göre en uygun tool'ları seçer.
 */
export class ToolDiscoveryEngine {
  private readonly toolRegistry = new Map<string, {
    id: string;
    name: string;
    description: string;
    keywords: string[];
    categories: string[];
    relevancePatterns: RegExp[];
    usageCount: number;
    successRate: number;
  }>();

  /**
   * Tool'u kaydet.
   */
  register(tool: {
    id: string;
    name: string;
    description: string;
    keywords?: string[];
    categories?: string[];
    relevancePatterns?: string[];
  }): void {
    this.toolRegistry.set(tool.id, {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      keywords: tool.keywords ?? [],
      categories: tool.categories ?? [],
      relevancePatterns: (tool.relevancePatterns ?? []).map(p => new RegExp(p, "i")),
      usageCount: 0,
      successRate: 1.0,
    });
  }

  /**
   * Task'a göre en uygun tool'ları bul.
   */
  discoverRelevantTools(
    taskDescription: string,
    maxTools: number = 10
  ): Array<{ id: string; name: string; description: string; relevanceScore: number }> {
    const taskLower = taskDescription.toLowerCase();
    const taskWords = taskLower.split(/\s+/).filter(w => w.length > 2);

    const scoredTools = [...this.toolRegistry.values()].map(tool => {
      let score = 0;

      // Keyword matching
      for (const keyword of tool.keywords) {
        if (taskLower.includes(keyword.toLowerCase())) {
          score += 2;
        }
      }

      // Description matching
      const descLower = tool.description.toLowerCase();
      for (const word of taskWords) {
        if (descLower.includes(word)) {
          score += 1;
        }
      }

      // Relevance patterns
      for (const pattern of tool.relevancePatterns) {
        if (pattern.test(taskDescription)) {
          score += 3;
        }
      }

      // Usage-based boost (popular tools are more likely relevant)
      score += Math.min(2, tool.usageCount / 10);

      // Success rate boost
      score += tool.successRate;

      return {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        relevanceScore: score,
      };
    });

    // Sort by relevance score and return top N
    return scoredTools
      .filter(t => t.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxTools);
  }

  /**
   * Tool kullanım istatistiklerini güncelle.
   */
  recordUsage(toolId: string, success: boolean): void {
    const tool = this.toolRegistry.get(toolId);
    if (tool) {
      tool.usageCount++;
      tool.successRate = (tool.successRate * (tool.usageCount - 1) + (success ? 1 : 0)) / tool.usageCount;
    }
  }

  /**
   * Tüm tool'ları listele.
   */
  listAll(): Array<{ id: string; name: string; description: string; usageCount: number; successRate: number }> {
    return [...this.toolRegistry.values()].map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      usageCount: t.usageCount,
      successRate: t.successRate,
    }));
  }
}

/**
 * Context Optimizer
 * 
 * Minimal context prensibi.
 * Budget sınırları içinde en önemli item'ları seçer.
 */
export class ContextOptimizer {
  private readonly defaultBudget: ContextBudget = {
    maxChars: 80000,
    maxItems: 100,
    maxTools: 20,
    maxMemories: 10,
    maxSkills: 5,
  };

  /**
   * Context'i optimize et.
   */
  optimize(
    items: ContextItem[],
    budget?: Partial<ContextBudget>
  ): ContextOptimizationResult {
    const effectiveBudget = { ...this.defaultBudget, ...budget };

    // Sort by relevance score (descending)
    const sorted = [...items].sort((a, b) => {
      // Priority first
      if (a.priority !== b.priority) return b.priority - a.priority;
      // Then relevance score
      return b.relevanceScore - a.relevanceScore;
    });

    const selected: ContextItem[] = [];
    const omitted: ContextItem[] = [];
    let totalChars = 0;

    // Count by type
    const typeCounts = new Map<string, number>();
    const typeChars = new Map<string, number>();

    for (const item of sorted) {
      const typeCount = typeCounts.get(item.type) ?? 0;
      const typeChar = typeChars.get(item.type) ?? 0;

      // Check type-specific limits
      const typeLimit = this.getTypeLimit(item.type, effectiveBudget);
      if (typeCount >= typeLimit) {
        omitted.push(item);
        continue;
      }

      // Check total limits
      if (selected.length >= effectiveBudget.maxItems) {
        omitted.push(item);
        continue;
      }

      if (totalChars + item.charCount > effectiveBudget.maxChars) {
        omitted.push(item);
        continue;
      }

      // Add to selected
      selected.push(item);
      totalChars += item.charCount;
      typeCounts.set(item.type, typeCount + 1);
      typeChars.set(item.type, typeChar + item.charCount);
    }

    const originalChars = items.reduce((sum, item) => sum + item.charCount, 0);
    const selectedChars = selected.reduce((sum, item) => sum + item.charCount, 0);
    const omittedChars = omitted.reduce((sum, item) => sum + item.charCount, 0);

    return {
      selected,
      omitted,
      totalChars,
      totalItems: selected.length,
      stats: {
        originalItems: items.length,
        selectedItems: selected.length,
        omittedItems: omitted.length,
        originalChars,
        selectedChars,
        omittedChars,
        compressionRatio: originalChars > 0 ? selectedChars / originalChars : 1,
      },
    };
  }

  private getTypeLimit(type: string, budget: ContextBudget): number {
    switch (type) {
      case "tool": return budget.maxTools;
      case "memory": return budget.maxMemories;
      case "skill": return budget.maxSkills;
      default: return budget.maxItems;
    }
  }
}

/**
 * Context Engineering Manager
 * 
 * Tool discovery ve context optimization'ı birleştirir.
 */
export class ContextEngineeringManager {
  readonly toolDiscovery: ToolDiscoveryEngine;
  readonly contextOptimizer: ContextOptimizer;

  constructor() {
    this.toolDiscovery = new ToolDiscoveryEngine();
    this.contextOptimizer = new ContextOptimizer();
  }

  /**
   * Tool'u kaydet.
   */
  registerTool(tool: {
    id: string;
    name: string;
    description: string;
    keywords?: string[];
    categories?: string[];
    relevancePatterns?: string[];
  }): void {
    this.toolDiscovery.register(tool);
  }

  /**
   * Task için optimize edilmiş context oluştur.
   */
  createContext(
    taskDescription: string,
    availableItems: ContextItem[],
    budget?: Partial<ContextBudget>
  ): ContextOptimizationResult {
    // Discover relevant tools
    const relevantTools = this.toolDiscovery.discoverRelevantTools(taskDescription, budget?.maxTools ?? 20);

    // Boost relevance scores for discovered tools
    const boostedItems = availableItems.map(item => {
      if (item.type === "tool") {
        const relevantTool = relevantTools.find(t => t.id === item.id);
        if (relevantTool) {
          return {
            ...item,
            relevanceScore: item.relevanceScore + relevantTool.relevanceScore,
          };
        }
      }
      return item;
    });

    // Optimize context
    return this.contextOptimizer.optimize(boostedItems, budget);
  }

  /**
   * Context istatistiklerini al.
   */
  getStats(): {
    totalTools: number;
    totalContextItems: number;
    avgRelevanceScore: number;
  } {
    const tools = this.toolDiscovery.listAll();
    return {
      totalTools: tools.length,
      totalContextItems: tools.length,
      avgRelevanceScore: tools.length > 0 ? tools.reduce((sum, t) => sum + t.successRate, 0) / tools.length : 0,
    };
  }
}

/**
 * Context Builder
 * 
 * Context item'ları oluşturmak için yardımcı sınıf.
 */
export class ContextBuilder {
  /**
   * Tool context item'ı oluştur.
   */
  static tool(tool: {
    id: string;
    name: string;
    description: string;
    risk?: string;
  }): ContextItem {
    return {
      id: tool.id,
      type: "tool",
      content: `- ${tool.id} [${tool.risk ?? "low"}]: ${tool.description}`,
      relevanceScore: 1,
      priority: 2,
      charCount: tool.description.length + tool.id.length + 10,
      source: "capability-broker",
    };
  }

  /**
   * Memory context item'ı oluştur.
   */
  static memory(memory: {
    id: string;
    content: string;
    importance: number;
    source: string;
  }): ContextItem {
    return {
      id: memory.id,
      type: "memory",
      content: memory.content,
      relevanceScore: memory.importance,
      priority: 3,
      charCount: memory.content.length,
      source: memory.source,
    };
  }

  /**
   * Skill context item'ı oluştur.
   */
  static skill(skill: {
    id: string;
    name: string;
    description: string;
  }): ContextItem {
    return {
      id: skill.id,
      type: "skill",
      content: `- ${skill.name}: ${skill.description}`,
      relevanceScore: 1,
      priority: 1,
      charCount: skill.description.length + skill.name.length + 5,
      source: "skill-registry",
    };
  }

  /**
   * Knowledge context item'ı oluştur.
   */
  static knowledge(knowledge: {
    id: string;
    content: string;
    source: string;
  }): ContextItem {
    return {
      id: knowledge.id,
      type: "knowledge",
      content: knowledge.content,
      relevanceScore: 1,
      priority: 1,
      charCount: knowledge.content.length,
      source: knowledge.source,
    };
  }

  /**
   * Instruction context item'ı oluştur.
   */
  static instruction(instruction: {
    id: string;
    content: string;
    priority?: number;
  }): ContextItem {
    return {
      id: instruction.id,
      type: "instruction",
      content: instruction.content,
      relevanceScore: 1,
      priority: instruction.priority ?? 0,
      charCount: instruction.content.length,
      source: "system",
    };
  }
}
