"use client";

import { useEffect, useState } from "react";
import { nextPollDelayMs } from "@/domain/poll";

type Live = { status: string; label: string; note: string; complete: boolean; failed: boolean };

export function JobPoller({ jobId, initial }: { jobId: string; initial: Live & { pollAfterMs: number | null } }) {
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    if (initial.pollAfterMs == null) return;
    let delay = initial.pollAfterMs;
    let previous = initial.status;
    let timer = 0;
    let cancelled = false;
    const tick = async () => {
      const response = await fetch(`/api/jobs/${jobId}`, { headers: { accept: "application/json" } });
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as Live;
      if (cancelled) return;
      const changed = data.status !== previous;
      setLive(data);
      const next = nextPollDelayMs(delay, changed, data.status);
      previous = data.status;
      if (next == null) return;
      delay = next;
      timer = window.setTimeout(tick, next);
    };
    timer = window.setTimeout(tick, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId, initial.pollAfterMs, initial.status]);

  if (!live || live.status === initial.status) return null;
  return (
    <p data-live-status={live.status}>
      <strong>{live.label}.</strong> {live.note}
    </p>
  );
}
