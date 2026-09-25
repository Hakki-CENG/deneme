import type { ZodTypeAny } from "zod";
import { z } from "zod";
import type { Capability, CapabilityContext, CapabilityDescriptor, JsonValue } from "../types.js";
import { asJsonValue } from "../util/json.js";

export function zodToSimpleJsonSchema(schema: ZodTypeAny): JsonValue {
  const shape = schema instanceof z.ZodObject ? schema.shape : {};
  const properties: Record<string, JsonValue> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    let current = value as ZodTypeAny;
    const optional = current.isOptional();
    if (optional) {
      const inner = (current as ZodTypeAny & { _def?: { innerType?: ZodTypeAny } })._def?.innerType;
      if (inner) current = inner;
    }
    let type = "string";
    if (current instanceof z.ZodNumber) type = "number";
    else if (current instanceof z.ZodBoolean) type = "boolean";
    else if (current instanceof z.ZodArray) type = "array";
    else if (current instanceof z.ZodObject) type = "object";
    properties[key] = { type };
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * P1.33: the optional common-contract half of a capability. Everything here is
 * a declaration the broker enforces, not documentation:
 *
 * - `output` is a zod schema the returned value must satisfy, or the call
 *   fails instead of handing back a shape the caller never agreed to.
 * - `idempotency` is a claim about re-running the capability (`inherent`:
 *   same state after two runs; `keyed`: deduplicated by idempotency key).
 * - `verify` runs after execution and checks the *effect* happened, not just
 *   the shape of the answer.
 * - `rollback` is best-effort compensation the broker attempts when execution
 *   fails after partially taking effect.
 */
export interface CapabilityContractSpec<TInput extends z.ZodObject<z.ZodRawShape>, TOutput extends z.ZodObject<z.ZodRawShape>> {
  output?: TOutput;
  idempotency?: "inherent" | "keyed";
  verify?: (output: JsonValue, context: CapabilityContext, input: z.infer<TInput>) => Promise<{ ok: boolean; reason?: string }>;
  rollback?: (input: z.infer<TInput>, context: CapabilityContext) => Promise<{ rolledBack: boolean; detail?: string }>;
}

export function defineCapability<TSchema extends z.ZodObject<z.ZodRawShape>>(
  descriptor: Omit<CapabilityDescriptor, "inputSchema">,
  schema: TSchema,
  execute: (input: z.infer<TSchema>, context: CapabilityContext) => Promise<unknown>,
  contract?: CapabilityContractSpec<TSchema, z.ZodObject<z.ZodRawShape>>,
): Capability {
  return {
    descriptor: {
      ...descriptor,
      inputSchema: zodToSimpleJsonSchema(schema),
      ...(contract?.idempotency ? { idempotency: contract.idempotency } : {}),
      ...(contract?.output ? { outputSchema: zodToSimpleJsonSchema(contract.output) } : {}),
    },
    validate(input: unknown) {
      return schema.parse(input) as Record<string, JsonValue>;
    },
    ...(contract?.output
      ? {
          validateOutput(output: unknown): void {
            contract.output!.parse(output);
          },
        }
      : {}),
    async execute(input, context) {
      return asJsonValue(await execute(input as z.infer<TSchema>, context));
    },
    ...(contract?.verify
      ? {
          async verify(output: JsonValue, input: Record<string, JsonValue>, context: CapabilityContext) {
            return await contract.verify!(output, context, schema.parse(input) as z.infer<TSchema>);
          },
        }
      : {}),
    ...(contract?.rollback
      ? {
          async rollback(input: Record<string, JsonValue>, context: CapabilityContext) {
            return await contract.rollback!(schema.parse(input) as z.infer<TSchema>, context);
          },
        }
      : {}),
  };
}
