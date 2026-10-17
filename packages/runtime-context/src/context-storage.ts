import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionContext } from './execution-context.js';

const storage = new AsyncLocalStorage<ExecutionContext>();

/**
 * Runs `fn` with `ctx` as the ambient execution context (request-scoped, async-safe).
 *
 * AsyncLocalStorage is what keeps this design valid for runtimes that serve several requests
 * concurrently in one process (Lambda Web Functions, Fargate): module-level mutable state would
 * leak one tenant's identifiers into another tenant's log lines.
 */
export function runWithContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Returns the ambient context or throws: adapters must never run tenant-less. */
export function getContext(): ExecutionContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error('ExecutionContext is not bound; wrap the handler with runWithContext()');
  }
  return ctx;
}

export function tryGetContext(): ExecutionContext | undefined {
  return storage.getStore();
}
