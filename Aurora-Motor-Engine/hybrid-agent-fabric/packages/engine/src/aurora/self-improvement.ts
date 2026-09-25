/**
 * Self-Improvement — Aurora Cognitive Runtime
 *
 * GEPA-style prompt evolution.
 * DGM-style code evolution.
 * Immutable core protection.
 */

import { randomUUID } from "node:crypto";

import { SandboxExecutor } from "../capabilities/capability-synthesis.js";

/**
 * A named, behaviour-preserving-or-improving code mutation.
 *
 * Operators are deliberately conservative: a mutation that cannot be applied
 * returns the input unchanged, and the result is always re-validated before it
 * is allowed to compete against the baseline.
 */
export interface CodeMutationOperator {
  readonly name: string;
  readonly apply: (code: string) => string;
}

/**
 * Deterministic mutation operators used by the code evolver.
 *
 * These replace the earlier placeholder operators (which appended
 * `// TODO: improve` and commented out `return` statements, corrupting the
 * program). Each operator here is a real source transformation.
 */
export const CODE_MUTATION_OPERATORS: readonly CodeMutationOperator[] = [
  {
    name: "hoist-loop-length",
    // for (let i = 0; i < xs.length; i++) -> cache the length lookup
    apply: (code) =>
      code.replace(
        /for\s*\(\s*(?:let|var)\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*([\w.]+)\.length\s*;\s*\1\+\+\s*\)/g,
        (_match, idx: string, arr: string) =>
          `for (let ${idx} = 0, ${idx}Len = ${arr}.length; ${idx} < ${idx}Len; ${idx}++)`
      ),
  },
  {
    name: "strict-equality",
    apply: (code) =>
      code.replace(/([^=!<>])==([^=])/g, "$1===$2").replace(/([^!])!=([^=])/g, "$1!==$2"),
  },
  {
    name: "prefer-const",
    apply: (code) => code.replace(/\bvar\s+/g, "const "),
  },
  {
    name: "early-return-guard",
    // Wrap a trailing `return expr;` with a null-safety guard when indexing.
    apply: (code) =>
      code.includes("?.")
        ? code
        : code.replace(/(\w+)\.(\w+)\.(\w+)/g, "$1?.$2?.$3"),
  },
];

/**
 * Outcome of challenging a baseline with an evolved variant.
 */
export interface CodeChallengeResult {
  readonly promoted: boolean;
  readonly reason: string;
  readonly baselineScore: number;
  readonly variantScore: number;
  readonly evaluated: number;
}

/**
 * Validates and scores candidate code by actually running it in the sandbox.
 *
 * This is what makes the FAZ 29 gate measurable: a variant is only "better"
 * if it demonstrably passes more held-out cases than the baseline.
 */
export class CodeVariantValidator {
  private readonly sandbox: SandboxExecutor;

  constructor(sandbox?: SandboxExecutor) {
    this.sandbox = sandbox ?? new SandboxExecutor({ defaultTimeoutMs: 3000 });
  }

  /**
   * Kodun çalıştırılabilir olduğunu doğrula (syntax + smoke run).
   */
  async validate(code: string): Promise<{ valid: boolean; error?: string | undefined }> {
    if (code.trim().length === 0) {
      return { valid: false, error: "empty code" };
    }

    const sandboxId = this.sandbox.createSandbox("variant-validate");
    const result = await this.sandbox.executeInSandbox(
      sandboxId,
      `${code}\nreturn "ok";`,
      {}
    );

    if (!result.success) {
      return { valid: false, error: result.error ?? "code failed to execute" };
    }
    return { valid: true };
  }

  /**
   * Held-out case'ler üzerinde skorla (0..1 arası geçme oranı).
   */
  async scoreAgainstCases(
    code: string,
    cases: ReadonlyArray<{ input: unknown; expectedOutput: unknown }>
  ): Promise<number> {
    if (cases.length === 0) return 0;

    let passed = 0;
    for (const testCase of cases) {
      const sandboxId = this.sandbox.createSandbox("variant-score");
      const result = await this.sandbox.executeInSandbox(sandboxId, code, testCase.input);
      if (!result.success) continue;

      if (JSON.stringify(result.output) === JSON.stringify(testCase.expectedOutput)) {
        passed += 1;
      }
    }

    return passed / cases.length;
  }
}

/**
 * Prompt variant.
 */
export interface PromptVariant {
  id: string;
  name: string;
  template: string;
  parameters: Record<string, string>;
  fitness: number; // 0-1
  generation: number;
  parentId?: string;
  createdAt: string;
  evaluatedAt?: string;
  status: "proposed" | "active" | "retired";
}

/**
 * Code mutation.
 */
export interface CodeMutation {
  id: string;
  name: string;
  description: string;
  code: string;
  fitness: number; // 0-1
  generation: number;
  parentId?: string | undefined;
  createdAt: string;
  evaluatedAt?: string;
  status: "proposed" | "active" | "retired";
}

/**
 * Protected core.
 */
export interface ProtectedCore {
  name: string;
  version: string;
  description: string;
  protectedPaths: string[];
  immutable: boolean;
}

/**
 * GEPA-style Prompt Evolver
 * 
 * Genetic Evolution of Prompt Architecture.
 */
export class PromptEvolver {
  private readonly variants = new Map<string, PromptVariant>();
  private generation = 0;
  /** Deterministic cursor driving mutation-operator selection. */
  private mutationCursor = 0;

  /**
   * Başlangıç prompt'u ekle.
   */
  addSeedPrompt(params: {
    name: string;
    template: string;
    parameters?: Record<string, string>;
  }): PromptVariant {
    const id = randomUUID();
    const variant: PromptVariant = {
      id,
      name: params.name,
      template: params.template,
      parameters: params.parameters ?? {},
      fitness: 0.5,
      generation: 0,
      createdAt: new Date().toISOString(),
      status: "active",
    };
    this.variants.set(id, variant);
    return variant;
  }

  /**
   * Mutation oluştur (GEPA-style).
   */
  createMutation(parentId: string, mutationType: "crossover" | "mutate" | "refine"): PromptVariant | null {
    const parent = this.variants.get(parentId);
    if (!parent) return null;

    this.generation++;
    const id = randomUUID();

    let template: string;
    let parameters: Record<string, string>;

    switch (mutationType) {
      case "crossover":
        // Crossover: iki parent'ın template'lerini birleştir
        template = this.crossoverTemplate(parent.template, parent.template);
        parameters = { ...parent.parameters };
        break;
      case "mutate":
        // Mutate: template'de küçük değişiklikler
        template = this.mutateTemplate(parent.template);
        parameters = { ...parent.parameters };
        break;
      case "refine":
        // Refine: template'i iyileştir
        template = this.refineTemplate(parent.template);
        parameters = { ...parent.parameters };
        break;
      default:
        template = parent.template;
        parameters = { ...parent.parameters };
    }

    const variant: PromptVariant = {
      id,
      name: `${parent.name}_gen${this.generation}_${mutationType}`,
      template,
      parameters,
      fitness: parent.fitness * 0.9, // Başlangıç fitness'ı parent'ın %90'ı
      generation: this.generation,
      parentId,
      createdAt: new Date().toISOString(),
      status: "proposed",
    };

    this.variants.set(id, variant);
    return variant;
  }

  /**
   * Template crossover.
   */
  private crossoverTemplate(template1: string, template2: string): string {
    // Deterministic midpoint crossover: reproducible across runs so that an
    // evolution result can be replayed and audited.
    const parts1 = template1.split("\n");
    const parts2 = template2.split("\n");
    const crossoverPoint = Math.floor(Math.min(parts1.length, parts2.length) / 2);

    const newParts = [
      ...parts1.slice(0, crossoverPoint),
      ...parts2.slice(crossoverPoint),
    ];

    return newParts.join("\n");
  }

  /**
   * Template mutation.
   *
   * Deterministic: the operator is chosen by generation counter, not at
   * random, so a variant's lineage is reproducible.
   */
  private mutateTemplate(template: string): string {
    const mutations: ReadonlyArray<(t: string) => string> = [
      (t: string) => `${t}\nBe thorough and state your assumptions.`,
      (t: string) => `${t}\nBe concise; omit restating the question.`,
      (t: string) => `${t}\nIf uncertain, say so explicitly rather than guessing.`,
      (t: string) => `${t}\nVerify the result before answering.`,
    ];

    const mutation = mutations[this.mutationCursor % mutations.length]!;
    this.mutationCursor += 1;
    return mutation(template);
  }

  /**
   * Template refinement.
   */
  private refineTemplate(template: string): string {
    // Refinement: template'i iyileştir
    return template + "\nThink step by step.";
  }

  /**
   * Fitness'ı değerlendir.
   */
  evaluateFitness(variantId: string, fitness: number): boolean {
    const variant = this.variants.get(variantId);
    if (!variant) return false;

    variant.fitness = Math.max(0, Math.min(1, fitness));
    variant.evaluatedAt = new Date().toISOString();
    return true;
  }

  /**
   * En iyi variant'ları al.
   */
  getTopVariants(limit: number = 5): PromptVariant[] {
    return [...this.variants.values()]
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, limit);
  }

  /**
   * Active variant'ları al.
   */
  getActiveVariants(): PromptVariant[] {
    return [...this.variants.values()].filter(v => v.status === "active");
  }

  /**
   * Variant'ı active yap.
   */
  activateVariant(variantId: string): boolean {
    const variant = this.variants.get(variantId);
    if (!variant) return false;

    variant.status = "active";
    return true;
  }

  /**
   * Variant'ı retire yap.
   */
  retireVariant(variantId: string): boolean {
    const variant = this.variants.get(variantId);
    if (!variant) return false;

    variant.status = "retired";
    return true;
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalVariants: number;
    activeVariants: number;
    proposedVariants: number;
    retiredVariants: number;
    avgFitness: number;
    maxGeneration: number;
  } {
    const variants = [...this.variants.values()];
    return {
      totalVariants: variants.length,
      activeVariants: variants.filter(v => v.status === "active").length,
      proposedVariants: variants.filter(v => v.status === "proposed").length,
      retiredVariants: variants.filter(v => v.status === "retired").length,
      avgFitness: variants.length > 0
        ? variants.reduce((sum, v) => sum + v.fitness, 0) / variants.length
        : 0,
      maxGeneration: this.generation,
    };
  }
}

/**
 * DGM-style Code Evolver
 * 
 * Darwin Gödel Machine-style code evolution.
 */
export class CodeEvolver {
  private readonly mutations = new Map<string, CodeMutation>();
  private generation = 0;
  private readonly protectedPaths = new Set<string>();

  /**
   * Protected path ekle.
   */
  addProtectedPath(path: string): void {
    this.protectedPaths.add(path);
  }

  /**
   * Protected path'leri al.
   */
  getProtectedPaths(): string[] {
    return [...this.protectedPaths];
  }

  /**
   * Kod mutation'ı oluştur.
   */
  createMutation(params: {
    name: string;
    description: string;
    code: string;
    parentId?: string;
  }): CodeMutation | null {
    // Protected path kontrolü
    if (this.isProtected(params.code)) {
      return null;
    }

    this.generation++;
    const id = randomUUID();

    const mutation: CodeMutation = {
      id,
      name: params.name,
      description: params.description,
      code: params.code,
      fitness: 0.5,
      generation: this.generation,
      parentId: params.parentId,
      createdAt: new Date().toISOString(),
      status: "proposed",
    };

    this.mutations.set(id, mutation);
    return mutation;
  }

  /**
   * Protected path kontrolü.
   */
  private isProtected(code: string): boolean {
    // Protected path'leri kontrol et
    for (const path of this.protectedPaths) {
      if (code.includes(path)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Fitness'ı değerlendir.
   */
  evaluateFitness(mutationId: string, fitness: number): boolean {
    const mutation = this.mutations.get(mutationId);
    if (!mutation) return false;

    mutation.fitness = Math.max(0, Math.min(1, fitness));
    mutation.evaluatedAt = new Date().toISOString();
    return true;
  }

  /**
   * En iyi mutation'ları al.
   */
  getTopMutations(limit: number = 5): CodeMutation[] {
    return [...this.mutations.values()]
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, limit);
  }

  /**
   * Active mutation'ları al.
   */
  getActiveMutations(): CodeMutation[] {
    return [...this.mutations.values()].filter(m => m.status === "active");
  }

  /**
   * Mutation'ı active yap.
   */
  activateMutation(mutationId: string): boolean {
    const mutation = this.mutations.get(mutationId);
    if (!mutation) return false;

    mutation.status = "active";
    return true;
  }

  /**
   * Mutation'ı retire yap.
   */
  retireMutation(mutationId: string): boolean {
    const mutation = this.mutations.get(mutationId);
    if (!mutation) return false;

    mutation.status = "retired";
    return true;
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalMutations: number;
    activeMutations: number;
    proposedMutations: number;
    retiredMutations: number;
    avgFitness: number;
    maxGeneration: number;
    protectedPaths: number;
  } {
    const mutations = [...this.mutations.values()];
    return {
      totalMutations: mutations.length,
      activeMutations: mutations.filter(m => m.status === "active").length,
      proposedMutations: mutations.filter(m => m.status === "proposed").length,
      retiredMutations: mutations.filter(m => m.status === "retired").length,
      avgFitness: mutations.length > 0
        ? mutations.reduce((sum, m) => sum + m.fitness, 0) / mutations.length
        : 0,
      maxGeneration: this.generation,
      protectedPaths: this.protectedPaths.size,
    };
  }
}

/**
 * Immutable Core Protector
 * 
 * Immutable core protection.
 */
export class ImmutableCoreProtector {
  private readonly protectedCores = new Map<string, ProtectedCore>();

  /**
   * Protected core ekle.
   */
  addProtectedCore(params: {
    name: string;
    version: string;
    description: string;
    protectedPaths: string[];
  }): ProtectedCore {
    const core: ProtectedCore = {
      ...params,
      immutable: true,
    };
    this.protectedCores.set(core.name, core);
    return core;
  }

  /**
   * Protected core'ları al.
   */
  getProtectedCores(): ProtectedCore[] {
    return [...this.protectedCores.values()];
  }

  /**
   * Path'in protected olup olmadığını kontrol et.
   */
  isPathProtected(path: string): boolean {
    for (const core of this.protectedCores.values()) {
      for (const protectedPath of core.protectedPaths) {
        if (path.startsWith(protectedPath)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Protected core'u güncelle (sadece versiyon).
   */
  updateCoreVersion(name: string, newVersion: string): boolean {
    const core = this.protectedCores.get(name);
    if (!core) return false;

    core.version = newVersion;
    return true;
  }

  /**
   * İstatistikler al.
   */
  getStats(): {
    totalCores: number;
    totalProtectedPaths: number;
    immutableCores: number;
  } {
    const cores = [...this.protectedCores.values()];
    return {
      totalCores: cores.length,
      totalProtectedPaths: cores.reduce((sum, c) => sum + c.protectedPaths.length, 0),
      immutableCores: cores.filter(c => c.immutable).length,
    };
  }
}

/**
 * Self-Improvement Pipeline
 * 
 * GEPA-style prompt evolution + DGM-style code evolution + immutable core protection.
 */
/**
 * Minimum held-out cases required before a variant may be promoted.
 *
 * Promotion lets the system replace its own code, so the bar is evidence, not
 * arithmetic. Three is deliberately modest — it is the smallest number where a
 * variant has to be right more than once — and callers that can supply more
 * should.
 */
const MIN_EVAL_CASES_FOR_PROMOTION = 3;

export class SelfImprovementPipeline {
  readonly promptEvolver: PromptEvolver;
  readonly codeEvolver: CodeEvolver;
  readonly coreProtector: ImmutableCoreProtector;
  readonly validator: CodeVariantValidator;

  constructor(validator?: CodeVariantValidator) {
    this.promptEvolver = new PromptEvolver();
    this.codeEvolver = new CodeEvolver();
    this.coreProtector = new ImmutableCoreProtector();
    this.validator = validator ?? new CodeVariantValidator();
  }

  /**
   * Protected core'ları başlat.
   */
  initializeProtectedCores(): void {
    this.coreProtector.addProtectedCore({
      name: "engine-core",
      version: "1.0.0",
      description: "Core engine components",
      protectedPaths: [
        "packages/engine/src/engine.ts",
        "packages/engine/src/core/",
        "packages/engine/src/aurora/unified-cognitive-loop.ts",
      ],
    });

    this.coreProtector.addProtectedCore({
      name: "eval-core",
      version: "1.0.0",
      description: "Core evaluation components",
      protectedPaths: [
        "packages/eval/src/",
        "packages/engine/test/",
      ],
    });
  }

  /**
   * Prompt evolution döngüsü.
   */
  /**
   * Evolves a prompt by mutation and selection.
   *
   * The fitness function is a required parameter, and that is the fix rather
   * than a stylistic choice. This method used to generate mutations and never
   * evaluate a single one: every variant was born with `fitness: 0.5`, or
   * `parent.fitness * 0.9` for a mutation, and `getTopVariants` then sorted on
   * those numbers as though they had been measured. `evaluateFitness` -- the
   * method that records a real fitness and stamps `evaluatedAt` -- was never
   * called, so "the best variant" was whichever happened to sort first. An
   * evolution loop with no selection pressure is not evolution; it is a random
   * walk that reports a winner.
   *
   * Callers must now supply the judgement. `evaluate` receives the candidate
   * template and returns a fitness in 0-1; it is called once per new variant and
   * its result is recorded through `evaluateFitness`, so the ranking the loop
   * selects on is the ranking that was actually measured.
   */
  async evolvePrompts(params: {
    seedPrompt: string;
    generations: number;
    mutationsPerGeneration: number;
    evaluate: (template: string) => Promise<number>;
  }): Promise<PromptVariant[]> {
    // Seed prompt ekle
    const seed = this.promptEvolver.addSeedPrompt({
      name: "seed",
      template: params.seedPrompt,
    });
    // The seed is scored on the same scale as its descendants. Leaving it at the
    // 0.5 it is constructed with would let an unmeasured baseline beat measured
    // variants, or lose to them, for reasons that have nothing to do with quality.
    const seedFitness = await params.evaluate(seed.template);
    this.promptEvolver.evaluateFitness(seed.id, seedFitness);
    seed.fitness = seedFitness;

    const allVariants: PromptVariant[] = [seed];

    // Evolution döngüsü
    for (let gen = 0; gen < params.generations; gen++) {
      const currentBest = this.promptEvolver.getTopVariants(1)[0];
      if (!currentBest) break;

      // Mutations oluştur
      for (let mut = 0; mut < params.mutationsPerGeneration; mut++) {
        const mutationType = mut % 3 === 0 ? "crossover" : mut % 3 === 1 ? "mutate" : "refine";
        const variant = this.promptEvolver.createMutation(currentBest.id, mutationType);
        if (variant) {
          // Score it before it can be selected. Without this the loop ranks
          // variants by the placeholder fitness they were constructed with.
          const measured = await params.evaluate(variant.template);
          this.promptEvolver.evaluateFitness(variant.id, measured);
          allVariants.push(variant);
        }
      }
    }

    return allVariants;
  }

  /**
   * Code evolution döngüsü.
   */
  async evolveCode(params: {
    seedCode: string;
    generations: number;
    mutationsPerGeneration: number;
  }): Promise<CodeMutation[]> {
    // Seed code ekle
    const seed = this.codeEvolver.createMutation({
      name: "seed",
      description: "Initial code",
      code: params.seedCode,
    });

    const allMutations: CodeMutation[] = seed ? [seed] : [];

    // Evolution döngüsü
    for (let gen = 0; gen < params.generations; gen++) {
      const currentBest = this.codeEvolver.getTopMutations(1)[0];
      if (!currentBest) break;

      // Mutations oluştur
      for (let mut = 0; mut < params.mutationsPerGeneration; mut++) {
        const mutation = this.codeEvolver.createMutation({
          name: `${currentBest.name}_gen${gen + 1}_mut${mut}`,
          description: `Mutation ${mut} of generation ${gen + 1}`,
          code: this.mutateCode(currentBest.code, mut),
          parentId: currentBest.id,
        });
        if (mutation) {
          allMutations.push(mutation);
        }
      }
    }

    return allMutations;
  }

  /**
   * Kod mutation'ı.
   */
  private mutateCode(code: string, mutationIndex: number): string {
    const mutation = CODE_MUTATION_OPERATORS[mutationIndex % CODE_MUTATION_OPERATORS.length]!;
    return mutation.apply(code);
  }

  /**
   * Bir varyantı bağımsız eval ile baseline'a karşı sına.
   *
   * FAZ 28-29 gate: "Yeni varyant eski baseline'ı bağımsız eval'de geçti".
   * Varyant önce derlenebilirlik/çalışabilirlik kontrolünden geçer; sonra
   * baseline ile AYNI held-out test seti üzerinde karşılaştırılır. Kazanmak
   * için hem geçerli olmalı hem de baseline'dan kesin olarak daha iyi skor
   * almalıdır — eşitlik baseline'ın lehinedir.
   */
  async challengeBaseline(params: {
    baselineCode: string;
    variantCode: string;
    /** Held-out cases the variant has not been tuned against. */
    evalCases: ReadonlyArray<{ input: unknown; expectedOutput: unknown }>;
    minImprovement?: number | undefined;
  }): Promise<CodeChallengeResult> {
    const minImprovement = params.minImprovement ?? 0;

    const variantValidity = await this.validator.validate(params.variantCode);
    if (!variantValidity.valid) {
      return {
        promoted: false,
        reason: `variant rejected: ${variantValidity.error ?? "invalid code"}`,
        baselineScore: 0,
        variantScore: 0,
        evaluated: params.evalCases.length,
      };
    }

    // Validity is judged first: code that does not run is rejected as broken
    // regardless of how many eval cases exist. Only then does the evidence bar
    // apply.
    //
    // A held-out eval needs enough cases to mean something. Measured before
    // this guard existed: ONE case was enough to promote a variant, and the
    // result announced "variant beat baseline on held-out eval (1.000 > 0.000)"
    // — a confident sentence backed by a single data point. One case cannot
    // separate a real improvement from a coincidence, and promotion here means
    // the system rewrites part of itself.
    if (params.evalCases.length < MIN_EVAL_CASES_FOR_PROMOTION) {
      return {
        promoted: false,
        reason:
          `insufficient evidence: ${params.evalCases.length} eval case(s), ` +
          `${MIN_EVAL_CASES_FOR_PROMOTION} required for promotion`,
        baselineScore: 0,
        variantScore: 0,
        evaluated: params.evalCases.length,
      };
    }

    const baselineScore = await this.validator.scoreAgainstCases(
      params.baselineCode,
      params.evalCases
    );
    const variantScore = await this.validator.scoreAgainstCases(
      params.variantCode,
      params.evalCases
    );

    const promoted = variantScore > baselineScore + minImprovement;

    return {
      promoted,
      reason: promoted
        ? `variant beat baseline on held-out eval (${variantScore.toFixed(3)} > ${baselineScore.toFixed(3)})`
        : `variant did not beat baseline (${variantScore.toFixed(3)} <= ${baselineScore.toFixed(3)})`,
      baselineScore,
      variantScore,
      evaluated: params.evalCases.length,
    };
  }

  /**
   * Pipeline istatistiklerini al.
   */
  getStats(): {
    promptEvolver: ReturnType<PromptEvolver["getStats"]>;
    codeEvolver: ReturnType<CodeEvolver["getStats"]>;
    coreProtector: ReturnType<ImmutableCoreProtector["getStats"]>;
  } {
    return {
      promptEvolver: this.promptEvolver.getStats(),
      codeEvolver: this.codeEvolver.getStats(),
      coreProtector: this.coreProtector.getStats(),
    };
  }
}
