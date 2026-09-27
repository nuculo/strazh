import type { EffectCapability } from './effect.js';

/**
 * §6: "Each EngineAdapter declares a capability per operation family, not one
 * global flag for the whole adapter." A plain lookup, keyed by
 * `${engineAdapterId}:${operationFamily}` — §6's own rule for anything absent from
 * it: "default for an undeclared operation is AT_MOST_ONCE_UNPROVEN." There is
 * deliberately no method to raise a capability at runtime — §6: "an adapter cannot
 * raise its capability dynamically without a new version/digest," so the only way
 * to change one is to construct a new declarations map (a new adapter version).
 */
export interface OperationCapabilityKey {
  readonly engineAdapterId: string;
  readonly operationFamily: string;
}

export type OperationCapabilityDeclarations = ReadonlyMap<string, EffectCapability>;

/** JSON-encoded, not `${a}:${b}` — a plain colon-join would collide, e.g. `{a:'x:y', b:'z'}` and `{a:'x', b:'y:z'}` both joining to `"x:y:z"`. */
export function capabilityKey(key: OperationCapabilityKey): string {
  return JSON.stringify([key.engineAdapterId, key.operationFamily]);
}

export function declareCapabilities(entries: readonly (OperationCapabilityKey & { readonly capability: EffectCapability })[]): OperationCapabilityDeclarations {
  return new Map(entries.map((e) => [capabilityKey(e), e.capability]));
}

export function resolveCapability(declarations: OperationCapabilityDeclarations, key: OperationCapabilityKey): EffectCapability {
  return declarations.get(capabilityKey(key)) ?? 'AT_MOST_ONCE_UNPROVEN';
}
