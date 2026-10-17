import { defineConfig } from 'vitest/config';

// aws-cdk-lib is large; the first synth in a worker can exceed the default 5 s on cold caches.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
