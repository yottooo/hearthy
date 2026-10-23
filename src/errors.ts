/** An expected failure whose message is safe to show the user as-is. */
export class HearthyError extends Error {
  override name = 'HearthyError';
}

/** True when the error (or anything in its cause chain) is a refused TCP connection. */
export function isConnectionRefused(err: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if ('code' in current && current.code === 'ECONNREFUSED') return true;
    if ('cause' in current) queue.push(current.cause);
    if ('errors' in current && Array.isArray(current.errors)) queue.push(...current.errors);
  }
  return false;
}
