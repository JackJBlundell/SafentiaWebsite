// ============================================================================
// Jest config for the unit-test suite (brief 18.2): pure business logic such as
// the proportional RAG gauge (story 1072), report assembly and validation. The
// security-rules matrix has its own emulator-backed config (jest.rules.config.js)
// and is excluded here so the two never run in the same process.
//
// ts-jest compiles the TypeScript sources directly so tests import from src/*
// without a separate build step. Deterministic only - no wall-clock, network or
// ordering reliance (brief 18.2).
// ============================================================================

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Unit tests live under __tests__ but NOT under __tests__/rules (those need the
  // emulator and run via jest.rules.config.js).
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/lib/', '/__tests__/rules/'],
};
