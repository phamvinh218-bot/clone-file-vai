const ACTIVE = new Set(["dispatch_pending", "dispatched", "leased"]);

export function nextPollDelayMs(previous: number | null, statusChanged: boolean, status: string): number | null {
  if (!ACTIVE.has(status)) return null;
  if (previous == null || statusChanged) return 2000;
  return Math.min(20_000, previous * 2);
}
