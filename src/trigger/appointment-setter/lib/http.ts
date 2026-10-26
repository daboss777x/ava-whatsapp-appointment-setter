/**
 * fetch with a hard timeout. A stalled network connection must fail fast and retry,
 * never hang the run (one customer's runs queue behind each other).
 */
export async function fetchWithTimeout(url: string | URL | Request, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
}

/** Retry an idempotent call once after a short pause on network errors, timeouts or 5xx. */
export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = String(err);
    const transient = /timeout|aborted|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|→ 5\d\d/i.test(msg);
    if (!transient) throw err;
    console.warn(`${label} failed, retrying once`, { error: msg.slice(0, 200) });
    await new Promise((r) => setTimeout(r, 1500));
    return fn();
  }
}
