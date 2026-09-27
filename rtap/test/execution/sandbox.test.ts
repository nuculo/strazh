import { describe, expect, it } from 'vitest';
import { minimalSandboxProfile, scopedExecOptions } from '../../src/execution/sandbox.js';

describe('sandbox (грань №15 — privilege/env scoping for defaultExec())', () => {
  describe('minimalSandboxProfile', () => {
    it('carries only PATH from the real process environment, nothing else', () => {
      const profile = minimalSandboxProfile();
      expect(Object.keys(profile.env)).toEqual(process.env.PATH !== undefined ? ['PATH'] : []);
      if (process.env.PATH !== undefined) {
        expect(profile.env.PATH).toBe(process.env.PATH);
      }
    });

    it('declares no uid/gid — those are opt-in only, never a default', () => {
      const profile = minimalSandboxProfile();
      expect(profile.uid).toBeUndefined();
      expect(profile.gid).toBeUndefined();
    });
  });

  describe('scopedExecOptions', () => {
    it('with no sandbox given, defaults to minimalSandboxProfile() rather than inheriting full process.env', () => {
      const opts = scopedExecOptions(undefined, undefined);
      expect(opts.env).toEqual(minimalSandboxProfile().env);
      expect(opts).not.toHaveProperty('uid');
      expect(opts).not.toHaveProperty('gid');
    });

    it('with an explicit sandbox, uses exactly its env — not merged with process.env', () => {
      const opts = scopedExecOptions(undefined, { env: { CUSTOM_VAR: 'x' } });
      expect(opts.env).toEqual({ CUSTOM_VAR: 'x' });
    });

    it('threads uid/gid through when the profile declares them, and omits the keys entirely when it does not', () => {
      const withIds = scopedExecOptions(undefined, { env: {}, uid: 1000, gid: 1000 });
      expect(withIds.uid).toBe(1000);
      expect(withIds.gid).toBe(1000);

      const withoutIds = scopedExecOptions(undefined, { env: {} });
      expect(withoutIds).not.toHaveProperty('uid');
      expect(withoutIds).not.toHaveProperty('gid');
    });

    it('threads cwd through when given, and omits the key entirely when not — matching exactOptionalPropertyTypes', () => {
      const withCwd = scopedExecOptions('/tmp/somewhere', undefined);
      expect(withCwd.cwd).toBe('/tmp/somewhere');

      const withoutCwd = scopedExecOptions(undefined, undefined);
      expect(withoutCwd).not.toHaveProperty('cwd');
    });

    it('defaults maxBuffer to 64MB, and respects an explicit override', () => {
      expect(scopedExecOptions(undefined, undefined).maxBuffer).toBe(64 * 1024 * 1024);
      expect(scopedExecOptions(undefined, undefined, 1024).maxBuffer).toBe(1024);
    });

    it('threads a positive timeout (with SIGKILL) for bounded execution, and omits it otherwise', () => {
      const bounded = scopedExecOptions(undefined, undefined, undefined, 30_000);
      expect(bounded.timeout).toBe(30_000);
      expect(bounded.killSignal).toBe('SIGKILL');

      // No timeout, or a non-positive one, must not set the key at all.
      expect(scopedExecOptions(undefined, undefined)).not.toHaveProperty('timeout');
      expect(scopedExecOptions(undefined, undefined, undefined, 0)).not.toHaveProperty('timeout');
    });
  });
});
