import { defineConfig } from 'vitest/config';

/**
 * `test/laws.test.ts` and `test/execution/admission.test.ts` each run the
 * *entire* LawRegistry (`registry.runAll()`) at least once — a cost that grows
 * with every law this repo adds, by design (there is no way to make "prove every
 * implemented law holds" cheap without proving fewer laws). Vitest's 5000ms
 * default `testTimeout` was tight enough that the registry crossing ~50 laws
 * pushed those tests past it on GitHub Actions' runner (measurably slower than
 * local dev machines) even though they stayed under it locally — a real CI
 * failure (2026-08-31, the audit #7 push), not a flaky one. A generous fixed
 * timeout, rather than hunting down every whole-registry test's own `it(...,
 * timeout)` argument each time a new law is added, is the fix that scales with
 * the registry.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
