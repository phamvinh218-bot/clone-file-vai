import { describe, expect, it } from "vitest";
import { nextPollDelayMs } from "@/domain/poll";
import { presentJob } from "@/jobs/present";
import type { Job } from "@/jobs/service";

describe("polling backoff", () => {
  it("starts at 2s, doubles while unchanged, and stops on a terminal status", () => {
    expect(nextPollDelayMs(null, true, "dispatched")).toBe(2000);
    expect(nextPollDelayMs(2000, false, "dispatched")).toBe(4000);
    expect(nextPollDelayMs(16000, false, "leased")).toBe(20000);
    expect(nextPollDelayMs(8000, true, "leased")).toBe(2000);
    expect(nextPollDelayMs(2000, false, "failed")).toBeNull();
    expect(nextPollDelayMs(2000, false, "completed")).toBeNull();
    expect(nextPollDelayMs(2000, false, "manual_handoff")).toBeNull();
  });
});

describe("failed jobs stay failed in the view", () => {
  it("does not present a failed job as complete", () => {
    const job = {
      id: "job",
      ownerId: "owner",
      status: "failed",
      rev: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      doc: {
        title: "Thử",
        specVersion: "applique-layout/1",
        scaleConfirmed: true,
        printReady: true,
        parse: { format: "svg", hasPhysicalUnit: true, artboard: null, pieces: [], warnings: [], unitName: "mm" },
        patternByPieceId: {},
        layout: null,
        warnings: [],
        lease: null,
        dispatch: { id: "d", httpStatus: 200, at: "2026-01-01T00:00:00.000Z" },
        dispatchLockUntil: null,
        dispatchError: null,
        completion: null,
        failure: { idempotencyKey: "fail-key-1", code: "render_failed", message: "Bot dừng", at: "2026-01-01T00:00:00.000Z" },
        handoff: null,
        attempt: 1,
      },
    } as unknown as Job;
    const view = presentJob(job, []);
    expect(view.failed).toBe(true);
    expect(view.complete).toBe(false);
    expect(view.poll).toBe(false);
    expect(view.label).toBe("Thất bại");
  });
});
