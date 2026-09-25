import { describe, it, expect } from "vitest";

import {
  PromptEvolver,
  CodeEvolver,
  ImmutableCoreProtector,
  CodeVariantValidator,
  SelfImprovementPipeline,
  CODE_MUTATION_OPERATORS,
} from "../src/aurora/self-improvement.js";

describe("code mutation operators (real transformations)", () => {
  it("never produces the old placeholder comment mutation", () => {
    const source = "function f(){ return 1; }";
    for (const op of CODE_MUTATION_OPERATORS) {
      const mutated = op.apply(source);
      expect(mutated).not.toContain("// TODO: improve");
      expect(mutated).not.toContain("return // optimized");
    }
  });

  it("hoists a loop length lookup", () => {
    const op = CODE_MUTATION_OPERATORS.find((o) => o.name === "hoist-loop-length")!;
    const out = op.apply("for (let i = 0; i < items.length; i++) { use(items[i]); }");
    expect(out).toContain("iLen = items.length");
  });

  it("upgrades loose equality to strict", () => {
    const op = CODE_MUTATION_OPERATORS.find((o) => o.name === "strict-equality")!;
    expect(op.apply("if (a == b) {}")).toContain("===");
    expect(op.apply("if (a != b) {}")).toContain("!==");
  });

  it("replaces var with const", () => {
    const op = CODE_MUTATION_OPERATORS.find((o) => o.name === "prefer-const")!;
    expect(op.apply("var x = 1;")).toBe("const x = 1;");
  });

  it("keeps mutated code syntactically valid", async () => {
    const validator = new CodeVariantValidator();
    const source = "const xs = [1,2,3]; let t = 0; for (let i = 0; i < xs.length; i++) { t += xs[i]; } return t;";

    for (const op of CODE_MUTATION_OPERATORS) {
      const mutated = op.apply(source);
      const check = await validator.validate(mutated);
      expect(check.valid, `${op.name} produced invalid code: ${check.error}`).toBe(true);
    }
  }, 30_000);
});

describe("CodeVariantValidator", () => {
  it("rejects empty code", async () => {
    const validator = new CodeVariantValidator();
    expect((await validator.validate("   ")).valid).toBe(false);
  });

  it("rejects code that does not run", async () => {
    const validator = new CodeVariantValidator();
    const result = await validator.validate("this is (((not javascript");
    expect(result.valid).toBe(false);
  });

  it("accepts runnable code", async () => {
    const validator = new CodeVariantValidator();
    expect((await validator.validate("const a = 1;")).valid).toBe(true);
  });

  it("scores code against held-out cases", async () => {
    const validator = new CodeVariantValidator();
    const score = await validator.scoreAgainstCases("return input.a + input.b;", [
      { input: { a: 1, b: 2 }, expectedOutput: 3 },
      { input: { a: 5, b: 5 }, expectedOutput: 10 },
    ]);
    expect(score).toBe(1);
  });

  it("gives a partial score for partially-correct code", async () => {
    const validator = new CodeVariantValidator();
    const score = await validator.scoreAgainstCases("return input.a + 1;", [
      { input: { a: 1, b: 2 }, expectedOutput: 2 },
      { input: { a: 5, b: 5 }, expectedOutput: 10 },
    ]);
    expect(score).toBe(0.5);
  });
});

describe("FAZ 29 gate — variant must beat baseline on independent eval", () => {
  it("promotes a variant that genuinely scores higher", async () => {
    const pipeline = new SelfImprovementPipeline();

    const result = await pipeline.challengeBaseline({
      baselineCode: "return input.a;",
      variantCode: "return input.a + input.b;",
      evalCases: [
        { input: { a: 1, b: 2 }, expectedOutput: 3 },
        { input: { a: 4, b: 6 }, expectedOutput: 10 },
        { input: { a: 7, b: 5 }, expectedOutput: 12 },
      ],
    });

    expect(result.promoted).toBe(true);
    expect(result.variantScore).toBeGreaterThan(result.baselineScore);
    expect(result.evaluated).toBe(3);
  }, 30_000);

  it("refuses to promote on a single eval case, however convincing the margin", async () => {
    const pipeline = new SelfImprovementPipeline();

    // MEASURED before the guard existed: this exact call returned
    // { promoted: true, reason: "variant beat baseline on held-out eval
    // (1.000 > 0.000)" }. A perfect score and a confident sentence, backed by
    // one data point. Promotion here means the system rewrites its own code,
    // so the bar is evidence rather than arithmetic.
    const result = await pipeline.challengeBaseline({
      baselineCode: "return 0;",
      variantCode: "return input.a + input.b;",
      evalCases: [{ input: { a: 1, b: 2 }, expectedOutput: 3 }],
    });

    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("insufficient evidence");
    expect(result.evaluated).toBe(1);
  }, 30_000);

  it("reports broken code as rejected, not as insufficient evidence", async () => {
    const pipeline = new SelfImprovementPipeline();

    // Ordering matters: a variant that cannot run is broken regardless of how
    // many eval cases accompany it. Reporting "insufficient evidence" here
    // would misdescribe the failure and invite someone to "fix" it by adding
    // cases.
    const result = await pipeline.challengeBaseline({
      baselineCode: "return input.a;",
      variantCode: "this is not valid javascript {{{",
      evalCases: [{ input: { a: 1 }, expectedOutput: 1 }],
    });

    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("rejected");
    expect(result.reason).not.toContain("insufficient evidence");
  }, 30_000);

  it("refuses to promote a variant that ties the baseline", async () => {
    const pipeline = new SelfImprovementPipeline();

    const result = await pipeline.challengeBaseline({
      baselineCode: "return input.a + input.b;",
      variantCode: "return input.b + input.a;",
      evalCases: [{ input: { a: 1, b: 2 }, expectedOutput: 3 }],
    });

    // Equal performance favours the incumbent.
    expect(result.promoted).toBe(false);
  }, 30_000);

  it("refuses to promote a variant that is worse", async () => {
    const pipeline = new SelfImprovementPipeline();

    const result = await pipeline.challengeBaseline({
      baselineCode: "return input.a + input.b;",
      variantCode: "return 0;",
      evalCases: [
        { input: { a: 1, b: 2 }, expectedOutput: 3 },
        { input: { a: 4, b: 6 }, expectedOutput: 10 },
        { input: { a: 7, b: 5 }, expectedOutput: 12 },
      ],
    });

    expect(result.promoted).toBe(false);
    expect(result.variantScore).toBeLessThan(result.baselineScore);
  }, 30_000);

  it("rejects a variant that does not even run", async () => {
    const pipeline = new SelfImprovementPipeline();

    const result = await pipeline.challengeBaseline({
      baselineCode: "return 1;",
      variantCode: "((((",
      evalCases: [{ input: {}, expectedOutput: 1 }],
    });

    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("rejected");
  }, 30_000);

  it("honours a required improvement margin", async () => {
    const pipeline = new SelfImprovementPipeline();

    // Variant is better on 1 of 4 cases => +0.25. A margin of 0.5 blocks it.
    const result = await pipeline.challengeBaseline({
      baselineCode: "return input.a === 1 ? 1 : 0;",
      variantCode: "return input.a === 1 || input.a === 2 ? input.a : 0;",
      evalCases: [
        { input: { a: 1 }, expectedOutput: 1 },
        { input: { a: 2 }, expectedOutput: 2 },
        { input: { a: 3 }, expectedOutput: 0 },
        { input: { a: 4 }, expectedOutput: 0 },
      ],
      minImprovement: 0.5,
    });

    expect(result.promoted).toBe(false);
  }, 30_000);
});

describe("PromptEvolver determinism", () => {
  it("produces reproducible mutations", () => {
    const makeVariant = (): string => {
      const evolver = new PromptEvolver();
      const seed = evolver.addSeedPrompt({
        name: "base",
        template: "Answer the question.",
        description: "seed",
      });
      const mutated = evolver.createMutation(seed.id, "mutate");
      return mutated?.template ?? "";
    };

    // Same inputs must yield the same output — no Math.random().
    expect(makeVariant()).toBe(makeVariant());
  });

  it("produces reproducible crossovers", () => {
    const makeCross = (): string => {
      const evolver = new PromptEvolver();
      evolver.addSeedPrompt({ name: "a", template: "L1\nL2\nL3", description: "" });
      const second = evolver.addSeedPrompt({ name: "b", template: "R1\nR2\nR3", description: "" });
      const crossed = evolver.createMutation(second.id, "crossover");
      return crossed?.template ?? "";
    };

    expect(makeCross()).toBe(makeCross());
  });
});

describe("ImmutableCoreProtector", () => {
  it("blocks mutation of protected paths", () => {
    const evolver = new CodeEvolver();
    evolver.addProtectedPath("src/security/core.ts");
    expect(evolver.getProtectedPaths()).toContain("src/security/core.ts");
  });

  it("tracks protected cores", () => {
    const protector = new ImmutableCoreProtector();
    protector.addProtectedCore({
      name: "verifier",
      version: "1.0.0",
      description: "cannot be self-modified",
      protectedPaths: ["src/aurora/integration-verification.ts"],
    });
    expect(protector.getStats()).toBeDefined();
    expect(protector.getProtectedCores().some((c) => c.name === "verifier")).toBe(true);
  });
});
