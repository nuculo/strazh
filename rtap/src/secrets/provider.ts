/**
 * ARCHITECTURE.md §1/§7.2: "Target credentials are represented only as secretRef,
 * never inline." `rtap:common#/$defs/SecretRef` has existed since Phase 0's schemas
 * and every `Target.secretRef` has carried one — but nothing has ever resolved one to
 * an actual value. This is that resolver.
 *
 * `secretRef` is scheme-prefixed (`"<scheme>:<locator>"`) so a production provider
 * (KMS/Vault, ARCHITECTURE.md §0) can be added later by registering another scheme,
 * not by replacing this one.
 */
export interface ResolvedSecret {
  readonly value: string;
}

export interface SecretProvider {
  resolve(secretRef: string): Promise<ResolvedSecret>;
}

export class UnsupportedSecretSchemeError extends Error {
  constructor(secretRef: string) {
    super(`unsupported secret scheme: ${secretRef}`);
    this.name = 'UnsupportedSecretSchemeError';
  }
}

export class SecretNotFoundError extends Error {
  constructor(secretRef: string) {
    super(`secret not found: ${secretRef}`);
    this.name = 'SecretNotFoundError';
  }
}

/** Splits `"env:TARGET_API_KEY"` into `{scheme: "env", locator: "TARGET_API_KEY"}`. */
export function parseSecretRef(secretRef: string): { scheme: string; locator: string } {
  const i = secretRef.indexOf(':');
  if (i <= 0 || i === secretRef.length - 1) throw new UnsupportedSecretSchemeError(secretRef);
  return { scheme: secretRef.slice(0, i), locator: secretRef.slice(i + 1) };
}
