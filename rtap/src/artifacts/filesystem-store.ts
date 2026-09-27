import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ArtifactNotFoundError,
  MalformedArtifactRefError,
  type ArtifactRef,
  type ArtifactStore,
  type PutArtifactInput,
  type WeightsRef,
} from './store.js';

const REF_PATTERN = /^local:sha256:([0-9a-f]{64})$/;

/**
 * Local profile of `ArtifactStore` — the production profile is S3-compatible
 * object storage (ARCHITECTURE.md §0), not implemented here: this repo has no live
 * bucket/credentials to test a real S3 client against, and a mocked one would just be
 * untested code wearing a real-looking name. What's built instead is genuine and
 * complete for the local profile: a content-addressed filesystem store, so `ref` is
 * exactly `local:sha256:<hex>` of the body and is never trusted as a caller-supplied
 * path — `get()`/`exists()` re-validate the pattern before touching the filesystem,
 * which also rules out path traversal by construction (a sha256 hex digest cannot
 * contain `/` or `..`).
 */
export class FilesystemArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string) {}

  /**
   * Shared by `put()`/`putWeights()` so evidence and model-weight bodies can never
   * diverge in hashing/path-safety logic — one implementation, two `kind` labels.
   */
  private async writeContentAddressed(body: string | Uint8Array): Promise<{ ref: string }> {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : Buffer.from(body);
    const digest = createHash('sha256').update(buf).digest('hex');
    const ref = `local:sha256:${digest}`;
    const filePath = this.pathFor(ref);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buf);
    return { ref };
  }

  async put(input: PutArtifactInput): Promise<ArtifactRef> {
    const { ref } = await this.writeContentAddressed(input.body);
    return { ref, kind: input.kind };
  }

  async putWeights(body: string | Uint8Array): Promise<WeightsRef> {
    const { ref } = await this.writeContentAddressed(body);
    return { ref, kind: 'model-weights' };
  }

  async get(ref: { readonly ref: string }): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(ref.ref));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArtifactNotFoundError(ref.ref);
      }
      throw err;
    }
  }

  async exists(ref: { readonly ref: string }): Promise<boolean> {
    try {
      await readFile(this.pathFor(ref.ref));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  private pathFor(ref: string): string {
    const match = REF_PATTERN.exec(ref);
    if (!match) throw new MalformedArtifactRefError(ref);
    const hex = match[1]!;
    return join(this.rootDir, hex.slice(0, 2), hex);
  }
}
