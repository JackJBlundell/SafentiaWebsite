// Vitest setup: jest-dom matchers for the component tests.
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Testing Library's own async budget, which is SEPARATE from vitest's
// testTimeout and is not covered by it: every findBy* and waitFor carries its
// own 1000ms default, so raising testTimeout to 20s (see vite.config.ts) did
// nothing for them.
//
// 1000ms is a fine budget for one file and far too tight for thirty-four. Vitest
// runs a worker per core, so what a query costs in the full suite is mostly
// contention rather than its own work - and a findByRole that resolves in 40ms
// alone can miss a one-second window on a busy runner. That produced a test
// that passed in isolation and failed in CI, which is the worst kind: it reads
// as a real regression every time, and it is never the same test twice.
//
// 5s is still short enough that a genuinely missing element fails quickly. It
// does NOT paper over a slow render: the query resolves the moment the element
// appears, so a passing test costs exactly what it did before.
configure({ asyncUtilTimeout: 5000 });
