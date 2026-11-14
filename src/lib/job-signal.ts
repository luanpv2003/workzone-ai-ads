import { AsyncLocalStorage } from "node:async_hooks";

// Stop signal for running background jobs (cancelled on the web, timed out, worker shutting down): the worker attaches it to each job,
// and Claude calls read it to stop the `claude` process / API connection immediately instead of running on uselessly.

const store = new AsyncLocalStorage<AbortSignal>();

export const CANCELLED = "__cancelled__";

export const runWithSignal = <T>(signal: AbortSignal, fn: () => Promise<T>) => store.run(signal, fn);

/** Signal of the current job; undefined when not running inside a background job (e.g. a user click on the web). */
export const jobSignal = () => store.getStore();

/** If the job was stopped, throw CANCELLED (catch sites in client-jobs ignore this error). */
export function throwIfStopped() {
  if (jobSignal()?.aborted) throw new Error(CANCELLED);
}
