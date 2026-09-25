import { defineConfig } from "vitest/config";

// The default 30s test timeout is too tight for the process-heavy campaign
// tests (real worker-process spawning, cross-process contention, sealed
// replay). Under a parallel full-suite run they time out spuriously while
// passing in isolation. 120s keeps a genuine hang detectable while removing
// the load-dependent flakes. No verification semantics are affected.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    // The heavy campaign tests spawn up to 8 real child processes each.
    // Unbounded file parallelism on this 10-core machine (4 of them held by
    // the Docker VM) oversubscribes the CPU so far that tests passing in 15s
    // alone blow a 120s budget. Four workers keeps the suite fast without
    // starving the process-spawning tests.
    maxWorkers: 4,
  },
});
