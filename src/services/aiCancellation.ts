// SDKs can finish after client cancellation. Stop our own wait/retry/fallback
// chain too, without treating a late provider response as a usable result.
export class AIRequestCancelledError extends Error {
  constructor() { super('AI request cancelled'); this.name = 'AIRequestCancelledError'; }
}
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AIRequestCancelledError();
}
export function withAISignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener('abort', cancelled); reject(new AIRequestCancelledError()); };
    // Attach handlers even when already cancelled, consuming late rejections.
    work.then(value => { signal.removeEventListener('abort', cancelled); resolve(value); },
      error => { signal.removeEventListener('abort', cancelled); reject(error); });
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
  });
}
export function aiRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(new AIRequestCancelledError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancelled); resolve(); }, ms);
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}
