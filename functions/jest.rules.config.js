// ============================================================================
// Jest config for the security-rules allow/deny matrix (brief 4.4).
//
// Run via the Firebase emulator so the REAL database.rules.json / storage.rules
// are evaluated, not a mock (from the repo root, where firebase.json lives):
//   npx firebase-tools emulators:exec --only database,storage \
//     --project safentia-tech 'npm --prefix functions run test:rules'
// CI runs exactly this command (see .github/workflows/ci.yml, rules-tests job).
//
// The matrix uses @firebase/rules-unit-testing, which needs the `firebase`
// client SDK. `firebase` is a devDependency of this package (it once resolved
// from a sibling app via moduleNameMapper, but CI has no sibling checkout, so
// the SDK is installed here and resolves normally - no mapping needed).
// ============================================================================

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/rules/**/*.test.ts'],
  testTimeout: 30000,
  // The rules tests share one emulator database, so run them serially for
  // deterministic, isolated state between cases.
  maxWorkers: 1,
};
