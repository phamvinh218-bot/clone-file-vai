import { randomBytes, randomUUID } from "node:crypto";
import { LAYOUT_SPEC, buildLayout, type LayoutResult } from "@/domain/layout";
import { AppError } from "@/domain/errors";
import { validateArtifact, validateMockup, validateVectorUpload } from "@/domain/files";
import { parseVectorFile } from "@/domain/geometry/parse";
import type { VectorParse, VectorWarning } from "@/domain/geometry/model";
import { ARTIFACT_KINDS, LIMITS, type ArtifactKind } from "@/domain/limits";
import { isPublicHttpsOrigin } from "@/domain/origin";
import { hashPassword, verifyPassword } from "@/domain/password";
import { assetSignatureValid, sha256Hex, signAsset } from "@/domain/sign";
import type { AppConfig } from "@/server/config";
import type { AssetRow, JobRow, Store } from "@/store/types";
import { buildDispatchPayload, postGrokBotWebhook } from "@/webhook/grok-bot";

const WORKER_OWNER = "worker";
const DUMMY_HASH = hashPassword("dummy-password-not-used");

export type JobDoc = {
  title: string;
  specVersion: string;
  scaleConfirmed: boolean;
  printReady: boolean;
  parse: VectorParse;
  patternByPieceId: Record<string, string>;
  layout: LayoutResult | null;
  warnings: VectorWarning[];
  lease: { id: string; holder: string; until: string; attempt: number } | null;
  dispatch: { id: string; httpStatus: number | null; at: string } | null;
  dispatchLockUntil: string | null;
  dispatchError: { code: string; message: string } | null;
  completion: { idempotencyKey: string; at: string } | null;
  failure: { idempotencyKey: string; code: string; message: string; at: string } | null;
  handoff: { at: string; packet: Record<string, unknown> } | null;
  attempt: number;
};

export type Job = Omit<JobRow, "doc"> & { doc: JobDoc };

const WORKER_VISIBLE = new Set(["dispatched", "leased", "completed", "failed"]);
const CLAIMABLE = new Set(["dispatched", "leased"]);

function jobOf(row: JobRow): Job {
  return { ...row, doc: row.doc as JobDoc };
}

function docRecord(doc: JobDoc): Record<string, unknown> {
  return doc as unknown as Record<string, unknown>;
}

export class JobService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  async registerStaff(email: string, password: string): Promise<{ id: string; email: string }> {
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@") || password.trim().length < LIMITS.passwordMin) {
      throw new AppError("invalid_staff", "Email không hợp lệ hoặc mật khẩu ngắn hơn 12 ký tự.", 422);
    }
    if (await this.store.findUserByEmail(normalized)) {
      throw new AppError("email_taken", "Email này đã có tài khoản.", 409);
    }
    const user = { id: randomUUID(), email: normalized, passwordHash: hashPassword(password), createdAt: this.iso() };
    await this.store.createUser(user);
    return { id: user.id, email: user.email };
  }

  async login(email: string, password: string): Promise<{ id: string; email: string }> {
    const user = await this.store.findUserByEmail(email.trim().toLowerCase());
    const ok = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new AppError("invalid_login", "Sai email hoặc mật khẩu.", 401);
    return { id: user.id, email: user.email };
  }

  async createJob(input: {
    ownerId: string;
    title: string;
    scaleConfirmed: boolean;
    idempotencyKey?: string | null;
    mockup: { filename: string; bytes: Buffer };
    vector: { filename: string; bytes: Buffer };
  }): Promise<Job> {
    const key = input.idempotencyKey?.trim();
    if (key) {
      if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(key)) throw new AppError("invalid_idempotency_key", "Idempotency-Key không hợp lệ.", 422);
      const existing = await this.store.getIdempotency(input.ownerId, "create", key);
      if (existing) {
        const job = await this.owned(input.ownerId, existing.jobId);
        return job;
      }
    }
    const title = input.title.trim().replace(/[\u0000-\u001f]/g, "");
    if (!title || title.length > LIMITS.titleChars) throw new AppError("invalid_title", "Thiếu tên việc hoặc tên quá dài.", 422);
    const mockup = validateMockup(input.mockup.filename, input.mockup.bytes);
    const vectorMeta = validateVectorUpload(input.vector.filename, input.vector.bytes);
    const parse = parseVectorFile(vectorMeta.filename, input.vector.bytes);
    const readiness = assessReadiness(parse, input.scaleConfirmed);
    const now = this.iso();
    const jobId = randomUUID();
    const doc: JobDoc = {
      title,
      specVersion: LAYOUT_SPEC.version,
      scaleConfirmed: input.scaleConfirmed,
      printReady: readiness.printReady,
      parse,
      patternByPieceId: {},
      layout: null,
      warnings: readiness.warnings,
      lease: null,
      dispatch: null,
      dispatchLockUntil: null,
      dispatchError: null,
      completion: null,
      failure: null,
      handoff: null,
      attempt: 0,
    };
    const row: JobRow = { id: jobId, ownerId: input.ownerId, status: "needs_pattern", rev: 1, doc: docRecord(doc), createdAt: now, updatedAt: now };
    await this.store.insertJob(row);
    await this.store.insertAsset(assetMeta(jobId, "mockup", null, mockup.filename, mockup.mediaType, input.mockup.bytes.length, now), input.mockup.bytes);
    await this.store.insertAsset(
      assetMeta(jobId, "vector", null, vectorMeta.filename, vectorMeta.mediaType, input.vector.bytes.length, now),
      input.vector.bytes,
    );
    if (key) await this.store.putIdempotency(input.ownerId, "create", key, jobId, now);
    return jobOf(row);
  }

  async listMine(ownerId: string): Promise<Job[]> {
    return (await this.store.listJobsByOwner(ownerId)).map(jobOf);
  }

  async owned(ownerId: string, jobId: string): Promise<Job> {
    const row = await this.store.getJob(jobId);
    if (!row || row.ownerId !== ownerId) throw new AppError("not_found", "Không tìm thấy việc.", 404);
    return jobOf(row);
  }

  async assignPatterns(ownerId: string, jobId: string, patterns: Record<string, string>): Promise<Job> {
    const job = await this.owned(ownerId, jobId);
    if (["completed", "failed", "leased", "dispatched", "dispatch_pending"].includes(job.status)) {
      throw new AppError("locked", "Không đổi hoa văn khi việc đã gửi hoặc đã kết thúc.", 409);
    }
    const patternByPieceId: Record<string, string> = {};
    for (const piece of job.doc.parse.pieces) {
      const raw = (patterns[piece.id] ?? "").trim().replace(/\s+/g, " ");
      if (!raw || raw.length > LIMITS.patternChars) {
        throw new AppError("pattern_required", `Mảnh ${piece.index} chưa có tên hoa văn.`, 422);
      }
      patternByPieceId[piece.id] = raw.toLocaleLowerCase("vi");
    }
    const layout = buildLayout(
      job.doc.parse.pieces.map((piece) => ({
        id: piece.id,
        index: piece.index,
        patternKey: patternByPieceId[piece.id],
        bbox: piece.bbox,
      })),
    );
    const readiness = assessReadiness(job.doc.parse, job.doc.scaleConfirmed);
    return this.mustTransition(job, "ready", {
      ...job.doc,
      patternByPieceId,
      layout,
      printReady: readiness.printReady,
      warnings: readiness.warnings,
    });
  }

  async dispatch(ownerId: string, jobId: string): Promise<{ job: Job; posted: boolean; replay: boolean }> {
    const job = await this.owned(ownerId, jobId);
    if (["dispatched", "leased", "completed"].includes(job.status)) return { job, posted: false, replay: true };
    if (job.status === "failed") throw new AppError("job_failed", "Việc đã thất bại, không gửi lại bằng cách đánh dấu xong.", 409);
    if (job.status === "dispatch_pending") {
      const until = Date.parse(job.doc.dispatchLockUntil ?? "");
      if (Number.isFinite(until) && until > this.now()) return { job, posted: false, replay: true };
    } else if (!["ready", "dispatch_failed", "manual_handoff"].includes(job.status)) {
      throw new AppError("not_ready", "Hãy gán hoa văn trước khi gửi.", 409);
    }
    if (!job.doc.layout) throw new AppError("not_ready", "Chưa có bố cục.", 409);
    if (!this.config.webhook) {
      throw new AppError("not_configured", "Chưa cấu hình GROK_BOT_WEBHOOK_URL và GROK_BOT_WEBHOOK_KEY. Việc chưa được gửi.", 503);
    }
    if (!this.config.appOrigin || !isPublicHttpsOrigin(this.config.appOrigin)) {
      throw new AppError(
        "origin_not_bot_reachable",
        "APP_ORIGIN không phải https công khai. Grok Bot không gọi được localhost. Việc chưa được gửi và chưa xong.",
        409,
      );
    }
    const locked = await this.transition(job, "dispatch_pending", {
      ...job.doc,
      dispatchLockUntil: new Date(this.now() + LIMITS.dispatchLockMs).toISOString(),
      dispatchError: null,
    });
    if (!locked) {
      const again = await this.owned(ownerId, jobId);
      if (["dispatch_pending", "dispatched", "leased", "completed"].includes(again.status)) {
        return { job: again, posted: false, replay: true };
      }
      throw new AppError("conflict", "Xung đột khi gửi việc.", 409);
    }
    const payload = buildDispatchPayload({
      jobId: locked.id,
      specVersion: locked.doc.specVersion,
      appOrigin: this.config.appOrigin,
    });
    try {
      const result = await postGrokBotWebhook({
        url: this.config.webhook.url,
        key: this.config.webhook.key,
        allowInsecure: this.config.webhookAllowInsecure,
        payload,
        fetchImpl: this.fetchImpl,
      });
      if (result.accepted) {
        const done = await this.mustTransition(locked, "dispatched", {
          ...locked.doc,
          dispatchLockUntil: null,
          dispatchError: null,
          dispatch: { id: randomUUID(), httpStatus: result.httpStatus, at: this.iso() },
        });
        return { job: done, posted: true, replay: false };
      }
      const failed = await this.mustTransition(locked, "dispatch_failed", {
        ...locked.doc,
        dispatchLockUntil: null,
        dispatch: { id: randomUUID(), httpStatus: result.httpStatus, at: this.iso() },
        dispatchError: {
          code: "webhook_rejected",
          message: `Webhook trả HTTP ${result.httpStatus}. Theo tài liệu, chỉ HTTP 200 mới nghĩa là bot đã bắt đầu chạy. Việc chưa xong.`,
        },
      });
      return { job: failed, posted: true, replay: false };
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Webhook không gửi được.";
      const failed = await this.mustTransition(locked, "dispatch_failed", {
        ...locked.doc,
        dispatchLockUntil: null,
        dispatch: { id: randomUUID(), httpStatus: null, at: this.iso() },
        dispatchError: { code: "webhook_unreachable", message },
      });
      return { job: failed, posted: true, replay: false };
    }
  }

  async manualHandoff(ownerId: string, jobId: string): Promise<Job> {
    const job = await this.owned(ownerId, jobId);
    if (!job.doc.layout) throw new AppError("not_ready", "Hãy gán hoa văn trước khi bàn giao tay.", 409);
    if (["completed", "failed", "leased", "dispatched", "dispatch_pending"].includes(job.status)) {
      throw new AppError("locked", "Việc đang chạy hoặc đã kết thúc.", 409);
    }
    const assets = await this.store.listAssets(job.id);
    const packet = {
      contract: "clone-file-vai.manual-handoff.v1",
      warning: "Bàn giao tay. Đây không phải lượt chạy của Grok Bot và không phải việc đã xong.",
      jobId: job.id,
      title: job.doc.title,
      specVersion: job.doc.specVersion,
      printReady: job.doc.printReady,
      layout: job.doc.layout,
      pieces: job.doc.parse.pieces,
      warnings: job.doc.warnings,
      appearance: appearanceNote(),
      sources: assets
        .filter((asset) => asset.role !== "artifact")
        .map((asset) => ({
          assetId: asset.id,
          filename: asset.filename,
          mediaType: asset.mediaType,
          byteSize: asset.byteSize,
          how: "Tải file từ trang việc của nhân viên và tự đính kèm trong chat bot. Gói này không tải file đi đâu.",
        })),
    };
    return this.mustTransition(job, "manual_handoff", {
      ...job.doc,
      handoff: { at: this.iso(), packet },
    });
  }

  async listActionable(): Promise<Job[]> {
    return (await this.store.listJobsByStatus(["dispatched", "leased"])).map(jobOf);
  }

  async workerGet(jobId: string): Promise<Job> {
    const row = await this.store.getJob(jobId);
    if (!row || !WORKER_VISIBLE.has(row.status)) throw new AppError("not_found", "Job is not visible to the worker.", 404);
    return jobOf(row);
  }

  async claim(jobId: string, workerId: string): Promise<Job> {
    const job = await this.workerGet(jobId);
    if (!CLAIMABLE.has(job.status)) throw new AppError("not_claimable", "Job cannot be claimed.", 409);
    const lease = job.doc.lease;
    const active = Boolean(lease && Date.parse(lease.until) > this.now());
    if (job.status === "leased" && active) throw new AppError("lease_held", "Another lease is still active.", 409);
    if (job.doc.attempt >= this.config.maxAttempts) {
      await this.mustTransition(job, "failed", {
        ...job.doc,
        lease: null,
        failure: {
          idempotencyKey: `lease-exhausted-${job.id}`,
          code: "lease_exhausted",
          message: "Too many claim attempts.",
          at: this.iso(),
        },
      });
      throw new AppError("lease_exhausted", "Job failed because the lease was exhausted.", 409);
    }
    const attempt = job.doc.attempt + 1;
    const holder = (workerId || "grok-bot").replace(/[^\w.:-]/g, "").slice(0, 64) || "grok-bot";
    return this.mustTransition(job, "leased", {
      ...job.doc,
      attempt,
      lease: { id: randomUUID(), holder, until: new Date(this.now() + this.config.leaseSeconds * 1000).toISOString(), attempt },
    });
  }

  async createSourceDownload(jobId: string, assetId: string): Promise<Record<string, unknown>> {
    const job = await this.workerGet(jobId);
    const asset = await this.store.getAsset(assetId);
    if (!asset || asset.jobId !== job.id) throw new AppError("not_found", "Asset not found.", 404);
    const base = {
      assetId: asset.id,
      jobId: job.id,
      filename: asset.filename,
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
      role: asset.role,
    };
    if (asset.byteSize <= LIMITS.inlineBytes) {
      return {
        ...base,
        delivery: "inline",
        bytesBase64: asset.bytes.toString("base64"),
        signedUrl: null,
        reachability: "inline_over_authenticated_mcp",
      };
    }
    if (!this.config.assetSigningSecret || !this.config.appOrigin || !isPublicHttpsOrigin(this.config.appOrigin)) {
      throw new AppError(
        "source_not_reachable",
        "File is too large to inline and APP_ORIGIN is not a public https origin, so no download URL was issued.",
        409,
      );
    }
    const exp = Math.floor(this.now() / 1000) + LIMITS.signedUrlSeconds;
    const sig = signAsset(this.config.assetSigningSecret, asset.id, exp);
    return {
      ...base,
      delivery: "signed_url",
      bytesBase64: null,
      signedUrl: `${this.config.appOrigin.replace(/\/$/, "")}/api/assets/${asset.id}/content?exp=${exp}&sig=${sig}`,
      expiresAt: exp,
      reachability: "public_origin",
    };
  }

  async signedAsset(assetId: string, exp: number, sig: string): Promise<AssetRow & { bytes: Buffer }> {
    if (!this.config.assetSigningSecret) throw new AppError("not_configured", "ASSET_SIGNING_SECRET is not set.", 503);
    if (!Number.isFinite(exp) || exp < Math.floor(this.now() / 1000)) throw new AppError("url_expired", "Signed URL expired.", 403);
    if (!assetSignatureValid(this.config.assetSigningSecret, assetId, exp, sig)) {
      throw new AppError("url_invalid", "Signed URL rejected.", 403);
    }
    const asset = await this.store.getAsset(assetId);
    if (!asset) throw new AppError("not_found", "Asset not found.", 404);
    return asset;
  }

  async createArtifactUpload(jobId: string, leaseId: string, artifactKind: string): Promise<Record<string, unknown>> {
    const job = await this.requireLease(jobId, leaseId);
    if (!ARTIFACT_KINDS.includes(artifactKind as ArtifactKind)) {
      throw new AppError("invalid_artifact", "artifactKind must be print_png, print_pdf, or proof_png.", 422);
    }
    const token = randomBytes(32).toString("base64url");
    const grantId = randomUUID();
    const expiresAt = new Date(this.now() + LIMITS.uploadGrantSeconds * 1000).toISOString();
    await this.store.insertGrant({
      id: grantId,
      jobId: job.id,
      tokenHash: sha256Hex(token),
      artifactKind,
      maxBytes: LIMITS.artifactBytes,
      expiresAt,
      usedAt: null,
    });
    const origin = this.config.appOrigin?.replace(/\/$/, "") ?? "";
    const local = !origin || !isPublicHttpsOrigin(origin);
    return {
      grantId,
      grantToken: token,
      method: "POST",
      uploadUrl: `${origin}/api/jobs/${job.id}/artifact-uploads/${grantId}`,
      artifactKind,
      expiresAt,
      reachability: local ? "local_process_only" : "public_origin",
      note: local
        ? "This upload URL is not reachable from the Grok Bot cloud computer. Posting bytes here only works for a process that can reach this origin."
        : "POST the file bytes with Authorization: Bearer grantToken. This server will not fetch a URL.",
    };
  }

  async acceptArtifact(input: { jobId: string; grantId: string; grantToken: string; bytes: Buffer; filename: string }): Promise<AssetRow> {
    const tokenHash = sha256Hex(input.grantToken);
    const peeked = await this.store.getGrantByHash(tokenHash);
    if (!peeked || peeked.id !== input.grantId || peeked.jobId !== input.jobId) {
      throw new AppError("grant_invalid", "Upload grant rejected.", 401);
    }
    if (peeked.usedAt || peeked.expiresAt <= this.iso()) {
      throw new AppError("grant_used", "Upload grant is expired or already used.", 409);
    }
    const job = await this.store.getJob(input.jobId);
    if (!job || job.status !== "leased" || !jobOf(job).doc.lease || Date.parse(jobOf(job).doc.lease!.until) <= this.now()) {
      throw new AppError("lease_mismatch", "Artifacts can only be stored while the lease is active.", 409);
    }
    const checked = validateArtifact(peeked.artifactKind, input.bytes);
    const consumed = await this.store.consumeGrant(tokenHash, this.iso());
    if (!consumed) throw new AppError("grant_used", "Upload grant is expired or already used.", 409);
    const meta = assetMeta(input.jobId, "artifact", checked.kind, input.filename || `${checked.kind}.bin`, checked.mediaType, input.bytes.length, this.iso());
    await this.store.replaceArtifact(meta, input.bytes);
    return meta;
  }

  async complete(jobId: string, leaseId: string, idempotencyKey: string): Promise<{ job: Job; replay: boolean }> {
    assertKey(idempotencyKey);
    const prior = await this.store.getIdempotency(WORKER_OWNER, "complete", idempotencyKey);
    if (prior && prior.jobId !== jobId) throw new AppError("idempotency_conflict", "Idempotency key belongs to another job.", 409);
    const current = await this.store.getJob(jobId);
    if (!current) throw new AppError("not_found", "Job not found.", 404);
    const job = jobOf(current);
    if (job.status === "failed") throw new AppError("job_failed", "A failed job cannot be marked complete.", 409);
    if (prior && job.status !== "completed") {
      throw new AppError("conflict", "Completion key was recorded before the job finished. Status was not changed.", 409);
    }
    if (job.status === "completed") return { job, replay: true };
    const leased = await this.requireLease(jobId, leaseId);
    const assets = await this.store.listAssets(jobId);
    const kinds = new Set(assets.filter((asset) => asset.role === "artifact").map((asset) => asset.kind));
    for (const required of ARTIFACT_KINDS) {
      if (!kinds.has(required)) throw new AppError("artifacts_missing", `Missing artifact ${required}.`, 409);
    }
    const done = await this.mustTransition(leased, "completed", {
      ...leased.doc,
      lease: null,
      completion: { idempotencyKey, at: this.iso() },
      failure: null,
    });
    await this.store.putIdempotency(WORKER_OWNER, "complete", idempotencyKey, jobId, this.iso());
    return { job: done, replay: false };
  }

  async fail(jobId: string, leaseId: string, idempotencyKey: string, code: string, message: string): Promise<{ job: Job; replay: boolean }> {
    assertKey(idempotencyKey);
    if (!/^[a-z0-9_]{2,40}$/.test(code) || !message.trim() || message.length > 500) {
      throw new AppError("invalid_failure", "Failure code or message is invalid.", 422);
    }
    const prior = await this.store.getIdempotency(WORKER_OWNER, "fail", idempotencyKey);
    if (prior && prior.jobId !== jobId) throw new AppError("idempotency_conflict", "Idempotency key belongs to another job.", 409);
    const current = await this.store.getJob(jobId);
    if (!current) throw new AppError("not_found", "Job not found.", 404);
    const job = jobOf(current);
    if (job.status === "completed") throw new AppError("job_completed", "A completed job cannot be failed.", 409);
    if (job.status === "failed" || prior) return { job, replay: true };
    const leased = await this.requireLease(jobId, leaseId);
    const done = await this.mustTransition(leased, "failed", {
      ...leased.doc,
      lease: null,
      failure: { idempotencyKey, code, message: message.trim(), at: this.iso() },
    });
    await this.store.putIdempotency(WORKER_OWNER, "fail", idempotencyKey, jobId, this.iso());
    return { job: done, replay: false };
  }

  async ownedAsset(ownerId: string, jobId: string, assetId: string): Promise<AssetRow & { bytes: Buffer }> {
    await this.owned(ownerId, jobId);
    const asset = await this.store.getAsset(assetId);
    if (!asset || asset.jobId !== jobId) throw new AppError("not_found", "Không tìm thấy file.", 404);
    return asset;
  }

  private async requireLease(jobId: string, leaseId: string): Promise<Job> {
    const job = await this.workerGet(jobId);
    if (job.status !== "leased" || job.doc.lease?.id !== leaseId) throw new AppError("lease_mismatch", "Lease does not match.", 409);
    if (Date.parse(job.doc.lease.until) <= this.now()) throw new AppError("lease_expired", "Lease expired.", 409);
    return job;
  }

  private async transition(job: Job, status: string, doc: JobDoc): Promise<Job | null> {
    const row = await this.store.compareAndSwapJob(job.id, job.rev, { status, doc: docRecord(doc), updatedAt: this.iso() });
    return row ? jobOf(row) : null;
  }

  private async mustTransition(job: Job, status: string, doc: JobDoc): Promise<Job> {
    const next = await this.transition(job, status, doc);
    if (!next) throw new AppError("conflict", "Job changed while it was being updated.", 409);
    return next;
  }
}

function assetMeta(
  jobId: string,
  role: AssetRow["role"],
  kind: string | null,
  filename: string,
  mediaType: string,
  byteSize: number,
  createdAt: string,
): AssetRow {
  return { id: randomUUID(), jobId, role, kind, filename, mediaType, byteSize, createdAt };
}

function assertKey(key: string) {
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(key)) throw new AppError("invalid_idempotency_key", "Idempotency key is invalid.", 422);
}

function assessReadiness(parse: VectorParse, scaleConfirmed: boolean): { printReady: boolean; warnings: VectorWarning[] } {
  const warnings = [...parse.warnings];
  if (!parse.hasPhysicalUnit) {
    warnings.push({ code: "no_physical_scale", message: "File không có đơn vị vật lý. Đây là bản xem trước, không phải file in 1:1." });
    return { printReady: false, warnings };
  }
  if (!scaleConfirmed) {
    warnings.push({ code: "scale_not_confirmed", message: "Chưa xác nhận tỉ lệ danh nghĩa 1:1. Đây là bản xem trước, không phải file in." });
    return { printReady: false, warnings };
  }
  const absurd = parse.pieces.some((piece) => piece.bbox.width < 2 || piece.bbox.height < 2 || piece.bbox.width > 2000 || piece.bbox.height > 2000);
  if (absurd) {
    warnings.push({ code: "sanity_check_failed", message: "Kích thước ngoài khoảng 2–2000 mm. Không đánh dấu sẵn sàng in." });
    return { printReady: false, warnings };
  }
  return { printReady: true, warnings };
}

export function appearanceNote(): string {
  return "Reconstruct appearance only. Geometry, holes, panel count, and the 10mm allowance come from this job and must not be redrawn by eye. Prefer sharp procedural stripe, check, dot, and star patterns. Floral art may use the bot's own image tools. Colors and motifs are approximate. Do not claim an exact recovery or a seamless tile. Do not add laser fiducials. Upload print_png, print_pdf, and proof_png through create_artifact_upload. HTTP 200 from the webhook only means the routine started.";
}
