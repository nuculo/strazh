import type { SigningAuthority } from '../signing/authority.js';
import type { SignedModelArtifact } from './model-artifact.js';

/**
 * Async wrapper over `packageLinearModelArtifact()`'s (synchronous, unsigned)
 * output — `packageLinearModelArtifact()` itself stays pure/sync/unchanged so
 * `test/training/model-artifact.test.ts`'s existing coverage of it keeps pinning
 * exactly what it always has.
 */
export async function signModelArtifact(artifact: SignedModelArtifact, authority: SigningAuthority): Promise<SignedModelArtifact> {
  const { signature: _unused, ...withoutSignature } = artifact;
  const { signature } = await authority.sign({ artifact: withoutSignature });
  return { ...artifact, signature };
}
