import { setTimeout } from 'node:timers/promises';

export function shutdownSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller.signal;
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await setTimeout(ms, undefined, { signal });
  } catch {
    if (!signal.aborted) throw new Error('Worker wait failed');
  }
}

export function logWorkerError(worker: string): void {
  console.error(
    JSON.stringify({
      worker,
      outcome: 'retry',
      code: 'INFRASTRUCTURE_FAILURE',
    }),
  );
}
