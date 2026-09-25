/**
 * Skill Composition — Aurora Cognitive Runtime
 *
 * Combine skills.
 * Dependency graph.
 * Cycle detection.
 */

import { randomUUID } from "node:crypto";

/**
 * Composite skill.
 */
export interface CompositeSkill {
  id: string;
  name: string;
  description: string;
  skills: string[]; // Skill IDs
  dependencies: SkillDependency[];
  executionOrder: string[]; // Topologically sorted skill IDs
  status: "draft" | "valid" | "invalid";
  createdAt: string;
  updatedAt: string;
}

/**
 * Skill dependency.
 */
export interface SkillDependency {
  from: string; // Skill ID
  to: string; // Skill ID
  type: "requires" | "optional" | "blocks";
  description?: string | undefined;
}

/**
 * Dependency graph node.
 */
export interface DependencyNode {
  id: string;
  skillId: string;
  dependencies: string[]; // Node IDs
  dependents: string[]; // Node IDs
  inDegree: number;
  outDegree: number;
}

/**
 * Cycle detection result.
 */
export interface CycleDetectionResult {
  hasCycle: boolean;
  cycles: string[][];
  message: string;
}

/**
 * Topological sort result.
 */
export interface TopologicalSortResult {
  sorted: string[];
  hasCycle: boolean;
  cycles?: string[][];
}

/**
 * Dependency Graph
 * 
 * Skill'ler arası bağımlılıkları yönetir.
 */
export class DependencyGraph {
  private readonly nodes = new Map<string, DependencyNode>();
  private readonly edges = new Map<string, SkillDependency[]>();

  /**
   * Node ekle.
   */
  addNode(skillId: string): string {
    const id = randomUUID();
    const node: DependencyNode = {
      id,
      skillId,
      dependencies: [],
      dependents: [],
      inDegree: 0,
      outDegree: 0,
    };
    this.nodes.set(id, node);
    return id;
  }

  /**
   * Edge ekle.
   */
  addEdge(fromNodeId: string, toNodeId: string, type: SkillDependency["type"], description?: string): boolean {
    const fromNode = this.nodes.get(fromNodeId);
    const toNode = this.nodes.get(toNodeId);
    if (!fromNode || !toNode) return false;

    // Edge ekle
    const edge: SkillDependency = {
      from: fromNode.skillId,
      to: toNode.skillId,
      type,
      description,
    };

    if (!this.edges.has(fromNodeId)) {
      this.edges.set(fromNodeId, []);
    }
    this.edges.get(fromNodeId)!.push(edge);

    // Node'ları güncelle
    fromNode.dependents.push(toNodeId);
    fromNode.outDegree++;
    toNode.dependencies.push(fromNodeId);
    toNode.inDegree++;

    return true;
  }

  /**
   * Cycle detection (DFS-based).
   */
  detectCycles(): CycleDetectionResult {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (nodeId: string, path: string[]): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const node = this.nodes.get(nodeId);
      if (!node) return false;

      for (const dependentId of node.dependents) {
        if (!visited.has(dependentId)) {
          if (dfs(dependentId, [...path])) {
            return true;
          }
        } else if (recursionStack.has(dependentId)) {
          // Cycle found
          const cycleStart = path.indexOf(dependentId);
          const cycle = path.slice(cycleStart);
          cycles.push(cycle);
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    };

    // Tüm node'ları kontrol et
    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId, []);
      }
    }

    return {
      hasCycle: cycles.length > 0,
      cycles,
      message: cycles.length > 0
        ? `Found ${cycles.length} cycle(s)`
        : "No cycles detected",
    };
  }

  /**
   * Topological sort (Kahn's algorithm).
   */
  topologicalSort(): TopologicalSortResult {
    // Önce cycle detection
    const cycleResult = this.detectCycles();
    if (cycleResult.hasCycle) {
      return {
        sorted: [],
        hasCycle: true,
        cycles: cycleResult.cycles,
      };
    }

    // Kahn's algorithm
    const inDegree = new Map<string, number>();
    const queue: string[] = [];
    const sorted: string[] = [];

    // In-degree hesapla
    for (const [nodeId, node] of this.nodes) {
      inDegree.set(nodeId, node.inDegree);
      if (node.inDegree === 0) {
        queue.push(nodeId);
      }
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      sorted.push(nodeId);

      const node = this.nodes.get(nodeId);
      if (!node) continue;

      for (const dependentId of node.dependents) {
        const currentInDegree = inDegree.get(dependentId) ?? 0;
        inDegree.set(dependentId, currentInDegree - 1);

        if (currentInDegree - 1 === 0) {
          queue.push(dependentId);
        }
      }
    }

    return {
      sorted,
      hasCycle: false,
    };
  }

  /**
   * Node'u al.
   */
  getNode(nodeId: string): DependencyNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Tüm node'ları al.
   */
  getNodes(): DependencyNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Edge'leri al.
   */
  getEdges(): SkillDependency[] {
    const allEdges: SkillDependency[] = [];
    for (const edges of this.edges.values()) {
      allEdges.push(...edges);
    }
    return allEdges;
  }

  /**
   * Node'un dependencies'lerini al.
   */
  getDependencies(nodeId: string): string[] {
    const node = this.nodes.get(nodeId);
    return node?.dependencies ?? [];
  }

  /**
   * Node'un dependent'larını al.
   */
  getDependents(nodeId: string): string[] {
    const node = this.nodes.get(nodeId);
    return node?.dependents ?? [];
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalNodes: number;
    totalEdges: number;
    hasCycles: boolean;
    rootNodes: number;
    leafNodes: number;
  } {
    const nodes = [...this.nodes.values()];
    const cycleResult = this.detectCycles();

    return {
      totalNodes: nodes.length,
      totalEdges: this.getEdges().length,
      hasCycles: cycleResult.hasCycle,
      rootNodes: nodes.filter(n => n.inDegree === 0).length,
      leafNodes: nodes.filter(n => n.outDegree === 0).length,
    };
  }
}

/**
 * Skill Composition Manager
 * 
 * Combine skills.
 */
export class SkillCompositionManager {
  private readonly compositeSkills = new Map<string, CompositeSkill>();
  private readonly dependencyGraph = new DependencyGraph();

  /**
   * Composite skill oluştur.
   */
  createCompositeSkill(params: {
    name: string;
    description: string;
    skills: string[];
    dependencies?: SkillDependency[];
  }): CompositeSkill {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Dependency graph'a node'ları ekle
    const nodeIds = new Map<string, string>();
    for (const skillId of params.skills) {
      const nodeId = this.dependencyGraph.addNode(skillId);
      nodeIds.set(skillId, nodeId);
    }

    // Dependency graph'a edge'leri ekle
    if (params.dependencies) {
      for (const dep of params.dependencies) {
        const fromNodeId = nodeIds.get(dep.from);
        const toNodeId = nodeIds.get(dep.to);
        if (fromNodeId && toNodeId) {
          this.dependencyGraph.addEdge(fromNodeId, toNodeId, dep.type, dep.description);
        }
      }
    }

    // Cycle detection
    const cycleResult = this.dependencyGraph.detectCycles();

    // Topological sort
    const sortResult = this.dependencyGraph.topologicalSort();

    // Execution order'ı skill ID'lere çevir
    const executionOrder = sortResult.sorted
      .map(nodeId => this.dependencyGraph.getNode(nodeId)?.skillId)
      .filter((id): id is string => id !== undefined);

    const compositeSkill: CompositeSkill = {
      id,
      name: params.name,
      description: params.description,
      skills: params.skills,
      dependencies: params.dependencies ?? [],
      executionOrder,
      status: cycleResult.hasCycle ? "invalid" : "valid",
      createdAt: now,
      updatedAt: now,
    };

    this.compositeSkills.set(id, compositeSkill);
    return compositeSkill;
  }

  /**
   * Composite skill'i güncelle.
   */
  updateCompositeSkill(skillId: string, updates: Partial<CompositeSkill>): boolean {
    const skill = this.compositeSkills.get(skillId);
    if (!skill) return false;

    Object.assign(skill, updates, { updatedAt: new Date().toISOString() });
    return true;
  }

  /**
   * Composite skill'i sil.
   */
  removeCompositeSkill(skillId: string): boolean {
    return this.compositeSkills.delete(skillId);
  }

  /**
   * Composite skill'i al.
   */
  getCompositeSkill(skillId: string): CompositeSkill | undefined {
    return this.compositeSkills.get(skillId);
  }

  /**
   * Tüm composite skill'leri al.
   */
  getCompositeSkills(): CompositeSkill[] {
    return [...this.compositeSkills.values()];
  }

  /**
   * Dependency graph'ı al.
   */
  getDependencyGraph(): DependencyGraph {
    return this.dependencyGraph;
  }

  /**
   * Skill'in dependency'lerini analiz et.
   */
  analyzeDependencies(skillId: string): {
    directDependencies: string[];
    transitiveDependencies: string[];
    isRoot: boolean;
    isLeaf: boolean;
  } {
    const skill = this.compositeSkills.get(skillId);
    if (!skill) {
      return { directDependencies: [], transitiveDependencies: [], isRoot: false, isLeaf: false };
    }

    const directDependencies = skill.dependencies
      .filter(d => d.type === "requires")
      .map(d => d.to);

    // Transitive dependencies (BFS)
    const transitiveDependencies = new Set<string>();
    const queue = [...directDependencies];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const depId = queue.shift()!;
      if (visited.has(depId)) continue;
      visited.add(depId);
      transitiveDependencies.add(depId);

      const depSkill = this.compositeSkills.get(depId);
      if (depSkill) {
        for (const dep of depSkill.dependencies) {
          if (dep.type === "requires") {
            queue.push(dep.to);
          }
        }
      }
    }

    return {
      directDependencies,
      transitiveDependencies: [...transitiveDependencies],
      isRoot: directDependencies.length === 0,
      isLeaf: ![...this.compositeSkills.values()].some((s: CompositeSkill) =>
        s.dependencies.some((d: SkillDependency) => d.to === skillId && d.type === "requires")
      ),
    };
  }

  /**
   * Cycle detection çalıştır.
   */
  detectCycles(): CycleDetectionResult {
    return this.dependencyGraph.detectCycles();
  }

  /**
   * Topological sort çalıştır.
   */
  topologicalSort(): TopologicalSortResult {
    return this.dependencyGraph.topologicalSort();
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalCompositeSkills: number;
    validSkills: number;
    invalidSkills: number;
    dependencyGraph: ReturnType<DependencyGraph["getStats"]>;
  } {
    const skills = [...this.compositeSkills.values()];
    return {
      totalCompositeSkills: skills.length,
      validSkills: skills.filter(s => s.status === "valid").length,
      invalidSkills: skills.filter(s => s.status === "invalid").length,
      dependencyGraph: this.dependencyGraph.getStats(),
    };
  }
}

/**
 * Skill Composition Validator
 * 
 * Composite skill'leri validate eder.
 */
export class SkillCompositionValidator {
  /**
   * Composite skill'i validate et.
   */
  validate(compositeSkill: CompositeSkill): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Boş skill listesi
    if (compositeSkill.skills.length === 0) {
      errors.push("Composite skill must have at least one skill");
    }

    // Duplicate skill'ler
    const uniqueSkills = new Set(compositeSkill.skills);
    if (uniqueSkills.size !== compositeSkill.skills.length) {
      errors.push("Composite skill has duplicate skills");
    }

    // Geçersiz dependency'ler
    for (const dep of compositeSkill.dependencies) {
      if (!compositeSkill.skills.includes(dep.from)) {
        errors.push(`Dependency source ${dep.from} not in skill list`);
      }
      if (!compositeSkill.skills.includes(dep.to)) {
        errors.push(`Dependency target ${dep.to} not in skill list`);
      }
    }

    // Self-dependency
    for (const dep of compositeSkill.dependencies) {
      if (dep.from === dep.to) {
        errors.push(`Self-dependency detected: ${dep.from}`);
      }
    }

    // Status kontrolü
    if (compositeSkill.status === "invalid") {
      warnings.push("Composite skill is marked as invalid (possibly due to cycles)");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
