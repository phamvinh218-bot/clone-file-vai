import { describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { JobService } from "@/jobs/service";
import { openTestRuntime, staff, storageNote, TINY_PNG, TWO_PIECE_SVG, clock } from "@/test/fixture";
import { postGrokBotWebhook, buildDispatchPayload } from "@/webhook/grok-bot";
import webhookSpec from "@/spec/grok-bot-webhook.v1.json";
import { createServer } from "node:http";
import { signAsset } from "@/domain/sign";

const drivers = ["memory-mock", "sqlite"] as const;

for (const driver of drivers) {
  describe(`jobs on ${driver}`, () => {
    it("labels the storage and keeps ownership, idempotency, leases, and completion honest", async () => {
      const tick = clock();
      const ctx = await openTestRuntime(driver, {
        now: tick.now,
        env: {
          GROK_BOT_WEBHOOK_URL: "https://hooks.example/routine",
          GROK_BOT_WEBHOOK_KEY: "routine-key-not-a-worker-token",
        },
      });
      try {
        expect(storageNote(ctx.store)).toContain(driver === "memory-mock" ? "TEST ONLY" : "Durable local SQLite");
        const vinh = await staff(ctx.services, "vinh@xuong.local");
        const lan = await staff(ctx.services, "lan@xuong.local");
        const created = await ctx.services.createJob({
          ownerId: vinh.id,
          title: "Hai mảnh",
          scaleConfirmed: true,
          idempotencyKey: "create-key-01",
          mockup: { filename: "mock.png", bytes: TINY_PNG },
          vector: { filename: "cut.svg", bytes: TWO_PIECE_SVG },
        });
        const replay = await ctx.services.createJob({
          ownerId: vinh.id,
          title: "Khác",
          scaleConfirmed: false,
          idempotencyKey: "create-key-01",
          mockup: { filename: "mock.png", bytes: TINY_PNG },
          vector: { filename: "cut.svg", bytes: TWO_PIECE_SVG },
        });
        expect(replay.id).toBe(created.id);
        await expect(ctx.services.owned(lan.id, created.id)).rejects.toMatchObject({ code: "not_found" });
        expect(created.doc.printReady).toBe(true);
        const patterned = await ctx.services.assignPatterns(vinh.id, created.id, {
          "piece-1": "Kẻ",
          "piece-2": "hoa",
        });
        expect(patterned.doc.layout?.mode).toBe("per_piece");
        expect(patterned.doc.layout?.marginPx).toBe(119);
        expect(patterned.doc.patternByPieceId["piece-1"]).toBe("kẻ");
        await expect(ctx.services.dispatch(vinh.id, created.id)).rejects.toMatchObject({ code: "origin_not_bot_reachable" });
        expect((await ctx.services.owned(vinh.id, created.id)).status).toBe("ready");

        const handoff = await ctx.services.manualHandoff(vinh.id, created.id);
        expect(handoff.status).toBe("manual_handoff");
        expect(handoff.doc.handoff?.packet.warning).toMatch(/không phải/);
        await expect(ctx.services.claim(created.id, "grok-bot")).rejects.toBeInstanceOf(AppError);
        expect((await ctx.services.owned(vinh.id, created.id)).status).toBe("manual_handoff");
      } finally {
        await ctx.close();
      }
    });

    it("dispatches once on HTTP 200, refuses to complete a failure, and replays completion", async () => {
      const tick = clock();
      let calls = 0;
      const deferred: { resolve?: (value: Response) => void } = {};
      const fetchImpl: typeof fetch = () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            deferred.resolve = resolve;
          });
        }
        return Promise.resolve(new Response("accepted", { status: 200 }));
      };
      const ctx = await openTestRuntime(driver, {
        now: tick.now,
        fetchImpl,
        env: {
          APP_ORIGIN: "https://xuong.example",
          GROK_BOT_WEBHOOK_URL: "https://hooks.example/routine",
          GROK_BOT_WEBHOOK_KEY: "routine-key-not-a-worker-token",
        },
      });
      try {
        const vinh = await staff(ctx.services, "vinh@xuong.local");
        const job = await ctx.services.createJob({
          ownerId: vinh.id,
          title: "Gửi bot",
          scaleConfirmed: true,
          mockup: { filename: "mock.png", bytes: TINY_PNG },
          vector: { filename: "cut.svg", bytes: TWO_PIECE_SVG },
        });
        await ctx.services.assignPatterns(vinh.id, job.id, { "piece-1": "ke", "piece-2": "ke" });
        const first = ctx.services.dispatch(vinh.id, job.id);
        const second = ctx.services.dispatch(vinh.id, job.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls).toBe(1);
        deferred.resolve?.(new Response(JSON.stringify({ finished: true }), { status: 200 }));
        const [a, b] = await Promise.all([first, second]);
        const posted = [a, b].filter((item) => item.posted);
        expect(posted).toHaveLength(1);
        expect(posted[0].job.status).toBe("dispatched");
        expect(posted[0].job.doc.completion).toBeNull();
        expect(calls).toBe(1);
        const again = await ctx.services.dispatch(vinh.id, job.id);
        expect(again.replay).toBe(true);
        expect(calls).toBe(1);

        const leased = await ctx.services.claim(job.id, "grok-bot");
        const upload = await ctx.services.createArtifactUpload(job.id, leased.doc.lease!.id, "print_png");
        const png = await ctx.services.acceptArtifact({
          jobId: job.id,
          grantId: String(upload.grantId),
          grantToken: String(upload.grantToken),
          bytes: TINY_PNG,
          filename: "print.png",
        });
        expect(png.kind).toBe("print_png");
        await expect(
          ctx.services.acceptArtifact({
            jobId: job.id,
            grantId: String(upload.grantId),
            grantToken: String(upload.grantToken),
            bytes: TINY_PNG,
            filename: "print.png",
          }),
        ).rejects.toMatchObject({ code: "grant_used" });
        await expect(ctx.services.complete(job.id, leased.doc.lease!.id, "complete-key-1")).rejects.toMatchObject({
          code: "artifacts_missing",
        });
        for (const kind of ["print_pdf", "proof_png"] as const) {
          const grant = await ctx.services.createArtifactUpload(job.id, leased.doc.lease!.id, kind);
          const bytes = kind === "print_pdf" ? Buffer.from(`%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n${" ".repeat(40)}`) : TINY_PNG;
          await ctx.services.acceptArtifact({
            jobId: job.id,
            grantId: String(grant.grantId),
            grantToken: String(grant.grantToken),
            bytes,
            filename: kind,
          });
        }
        const done = await ctx.services.complete(job.id, leased.doc.lease!.id, "complete-key-1");
        expect(done.job.status).toBe("completed");
        const replayed = await ctx.services.complete(job.id, leased.doc.lease!.id, "complete-key-1");
        expect(replayed.replay).toBe(true);
        expect(replayed.job.status).toBe("completed");
        await expect(ctx.services.fail(job.id, leased.doc.lease!.id, "fail-key-0001", "render_failed", "no")).rejects.toMatchObject({
          code: "job_completed",
        });
      } finally {
        await ctx.close();
      }
    });

    it("does not let a failed job become complete", async () => {
      let httpStatus = 500;
      const ctx = await openTestRuntime(driver, {
        env: {
          APP_ORIGIN: "https://xuong.example",
          GROK_BOT_WEBHOOK_URL: "https://hooks.example/routine",
          GROK_BOT_WEBHOOK_KEY: "routine-key-not-a-worker-token",
        },
        fetchImpl: async () => new Response("no", { status: httpStatus }),
      });
      try {
        const vinh = await staff(ctx.services, "vinh@xuong.local");
        const job = await makeReady(ctx.services, vinh.id);
        const failedDispatch = await ctx.services.dispatch(vinh.id, job.id);
        expect(failedDispatch.job.status).toBe("dispatch_failed");
        expect(failedDispatch.job.doc.completion).toBeNull();
        httpStatus = 201;
        const still = await ctx.services.dispatch(vinh.id, job.id);
        expect(still.job.status).toBe("dispatch_failed");
        httpStatus = 200;
        const sent = await ctx.services.dispatch(vinh.id, job.id);
        expect(sent.job.status).toBe("dispatched");
        const leased = await ctx.services.claim(job.id, "grok-bot");
        const failed = await ctx.services.fail(job.id, leased.doc.lease!.id, "fail-key-0001", "render_failed", "Dừng");
        expect(failed.job.status).toBe("failed");
        await expect(ctx.services.complete(job.id, leased.doc.lease!.id, "complete-key-2")).rejects.toMatchObject({ code: "job_failed" });
        expect((await ctx.services.workerGet(job.id)).status).toBe("failed");
      } finally {
        await ctx.close();
      }
    });
  });
}

describe("webhook sender contract", () => {
  it("posts bearer JSON and treats only HTTP 200 as dispatch, ignoring a finished flag in the body", async () => {
    const seen: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.statusCode = seen.length === 1 ? 200 : 201;
        res.end(JSON.stringify({ finished: true, success: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const payload = buildDispatchPayload({ jobId: "job-1", specVersion: "applique-layout/1", appOrigin: "https://xuong.example" });
      const key = "routine-key-value";
      const first = await postGrokBotWebhook({
        url: `http://127.0.0.1:${address.port}/hook`,
        key,
        allowInsecure: true,
        payload,
      });
      expect(first).toEqual({ httpStatus: 200, accepted: true });
      const second = await postGrokBotWebhook({
        url: `http://127.0.0.1:${address.port}/hook`,
        key,
        allowInsecure: true,
        payload,
      });
      expect(second.accepted).toBe(false);
      expect(second.httpStatus).toBe(201);
      const body = JSON.parse(seen[0].body) as Record<string, unknown>;
      expect(body.contract).toBe(webhookSpec.applicationPayload.contract);
      expect(body.mcpUrl).toBe("https://xuong.example/api/mcp");
      for (const forbidden of webhookSpec.applicationPayload.forbiddenKeys) expect(body).not.toHaveProperty(forbidden);
      expect(seen[0].headers.authorization).toBe(`Bearer ${key}`);
      expect(seen[0].headers["content-type"]).toContain("application/json");
      expect(seen[0].body.includes(key)).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects a newline in the key before sending", async () => {
    await expect(
      postGrokBotWebhook({
        url: "https://hooks.example/routine",
        key: "good-key\n",
        allowInsecure: false,
        payload: buildDispatchPayload({ jobId: "job-1", specVersion: "applique-layout/1", appOrigin: "https://xuong.example" }),
      }),
    ).rejects.toMatchObject({ code: "webhook_key_invalid" });
  });
});

describe("signed download", () => {
  it("rejects a bad signature and an expired URL", async () => {
    const tick = clock();
    const ctx = await openTestRuntime("sqlite", { now: tick.now });
    try {
      const vinh = await staff(ctx.services, "vinh@xuong.local");
      const job = await ctx.services.createJob({
        ownerId: vinh.id,
        title: "Ký",
        scaleConfirmed: true,
        mockup: { filename: "mock.png", bytes: TINY_PNG },
        vector: { filename: "cut.svg", bytes: TWO_PIECE_SVG },
      });
      const assets = await ctx.store.listAssets(job.id);
      const asset = assets[0];
      const exp = Math.floor(tick.now() / 1000) + 30;
      const sig = signAsset(ctx.runtime.config.assetSigningSecret!, asset.id, exp);
      const ok = await ctx.services.signedAsset(asset.id, exp, sig);
      expect(ok.bytes.equals(asset.role === "mockup" ? TINY_PNG : TWO_PIECE_SVG)).toBe(true);
      await expect(ctx.services.signedAsset(asset.id, exp, "tampered")).rejects.toMatchObject({ code: "url_invalid" });
      tick.state.ms += 120_000;
      await expect(ctx.services.signedAsset(asset.id, exp, sig)).rejects.toMatchObject({ code: "url_expired" });
    } finally {
      await ctx.close();
    }
  });
});

async function makeReady(services: JobService, ownerId: string) {
  const job = await services.createJob({
    ownerId,
    title: "Sẵn sàng",
    scaleConfirmed: true,
    mockup: { filename: "mock.png", bytes: TINY_PNG },
    vector: { filename: "cut.svg", bytes: TWO_PIECE_SVG },
  });
  await services.assignPatterns(ownerId, job.id, { "piece-1": "ke", "piece-2": "hoa" });
  return job;
}
