import { AppError, isAppError } from "@/domain/errors";
import { clearSessionCookie, readCookie, readSession, sessionCookieHeader, SESSION_COOKIE, signSession } from "@/domain/session";
import { presentJob } from "@/jobs/present";
import { handleMcpHttp } from "@/mcp/handler";
import type { Runtime } from "@/server/runtime";
import { getRequestRuntime } from "@/server/runtime";

export async function runtime(): Promise<Runtime> {
  return getRequestRuntime();
}

export function wantsHtml(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/html");
}

export function errorResponse(error: unknown): Response {
  if (isAppError(error)) return Response.json({ error: error.code, message: error.message }, { status: error.httpStatus });
  logSafeError(error);
  return Response.json(
    {
      error: "internal",
      message: "Lỗi nội bộ. Hãy tải lại trang đăng nhập và thử lại. Đừng gửi lại từ /api/session.",
    },
    { status: 500 },
  );
}

/** Log only the error name and code. Messages can contain the submitted email or other request input. */
export function logSafeError(error: unknown): void {
  const name = error instanceof Error ? error.name : "Error";
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  console.error(`[clone-file-vai] ${name}${code ? ` ${code}` : ""}`);
}

function redirect(req: Request, path: string, cookies: string[] = []): Response {
  let location = path;
  try {
    location = new URL(path, req.url).toString();
  } catch {
    location = path.startsWith("/") ? path : "/login";
  }
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function assertSameOrigin(req: Request) {
  const fetchSite = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  if (fetchSite === "cross-site") {
    throw new AppError("csrf", "Yêu cầu đến từ trang khác. Hãy mở lại trang đăng nhập rồi thử lại.", 403);
  }
  const origin = req.headers.get("origin");
  if (origin == null || origin.trim() === "") {
    if (fetchSite === "" || fetchSite === "same-origin" || fetchSite === "none" || fetchSite === "same-site") return;
    throw new AppError("csrf", "Yêu cầu đến từ trang khác. Hãy mở lại trang đăng nhập rồi thử lại.", 403);
  }
  if (origin.trim().toLowerCase() === "null") {
    throw new AppError(
      "origin_opaque",
      "Trình duyệt gửi Origin rỗng, nên đăng nhập bị từ chối. Hãy tải lại /login và đăng nhập từ đó. Đừng gửi lại từ /api/session.",
      403,
    );
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new AppError("origin_invalid", "Nguồn trang không phải địa chỉ hợp lệ. Hãy tải lại trang đăng nhập và thử lại.", 403);
  }
  if (originUrl.username || originUrl.password || (originUrl.protocol !== "http:" && originUrl.protocol !== "https:")) {
    throw new AppError("origin_invalid", "Nguồn trang không phải địa chỉ hợp lệ. Hãy tải lại trang đăng nhập và thử lại.", 403);
  }
  const originHost = originUrl.host;
  const host = req.headers.get("host");
  if (host && originHost === host) return;
  let requestHost = "";
  try {
    requestHost = new URL(req.url).host;
  } catch {
    requestHost = "";
  }
  if (requestHost && originHost === requestHost) return;
  throw new AppError("csrf", "Yêu cầu đến từ trang khác. Hãy mở lại trang đăng nhập rồi thử lại.", 403);
}

function requireServices(rt: Runtime) {
  if (!rt.services) throw new AppError("not_configured", "Kho dữ liệu chưa sẵn sàng. Xem trang thiết lập.", 503);
  return rt.services;
}

export async function staffId(req: Request, rt: Runtime): Promise<string | null> {
  if (!rt.config.sessionSecret) return null;
  const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  return readSession(rt.config.sessionSecret, token, Date.now())?.uid ?? null;
}

async function requireStaff(req: Request, rt: Runtime): Promise<string> {
  if (!rt.config.sessionSecret) throw new AppError("not_configured", "Thiếu SESSION_SECRET.", 503);
  requireServices(rt);
  const id = await staffId(req, rt);
  if (!id || !(await rt.store?.getUser(id))) throw new AppError("unauthorized", "Cần đăng nhập.", 401);
  return id;
}

function secure(req: Request): boolean {
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function handleSetup(): Promise<Response> {
  const rt = await runtime();
  return Response.json({
    gates: rt.gates,
    store: rt.store ? { driver: rt.store.driverName, label: rt.store.storageLabel } : null,
    storeError: rt.storeError,
    webhookTransport: "documented",
    payloadSchema: "application-defined",
    responseBody: "unverified_ignored",
    realBotRoundTrip: false,
  });
}

export async function handleLogin(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const rt = await runtime();
    const services = requireServices(rt);
    if (!rt.config.sessionSecret) throw new AppError("not_configured", "Thiếu SESSION_SECRET.", 503);
    const form = await req.formData();
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const user = await services.login(email, password);
    const cookie = sessionCookieHeader(signSession(rt.config.sessionSecret!, user.id, Date.now()), secure(req));
    if (wantsHtml(req)) return redirect(req, "/jobs", [cookie]);
    return Response.json({ id: user.id, email: user.email }, { headers: { "set-cookie": cookie } });
  } catch (error) {
    if (wantsHtml(req)) {
      if (!isAppError(error)) logSafeError(error);
      const code = isAppError(error) ? error.code : "internal";
      return redirect(req, `/login?error=${encodeURIComponent(code)}`);
    }
    return errorResponse(error);
  }
}

export async function handleLogout(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const cookie = clearSessionCookie(secure(req));
    if (wantsHtml(req)) return redirect(req, "/", [cookie]);
    return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleCreateStaff(req: Request): Promise<Response> {
  try {
    assertSameOrigin(req);
    const rt = await runtime();
    const services = requireServices(rt);
    const owner = await requireStaff(req, rt);
    void owner;
    const form = await req.formData();
    const created = await services.registerStaff(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
    if (wantsHtml(req)) return redirect(req, "/jobs?notice=staff");
    return Response.json(created, { status: 201 });
  } catch (error) {
    if (wantsHtml(req) && isAppError(error)) return redirect(req, `/jobs?error=${error.code}`);
    return errorResponse(error);
  }
}

export function newJobRetryQuery(code: string, title: string, scaleConfirmed: boolean): string {
  const params = new URLSearchParams();
  params.set("error", code);
  const clean = title.replace(/[\u0000-\u001f]/g, "").slice(0, 120);
  if (clean) params.set("title", clean);
  if (scaleConfirmed) params.set("scale", "1");
  return params.toString();
}

export async function handleCreateJob(req: Request): Promise<Response> {
  let formTitle = "";
  let scaleConfirmed = false;
  try {
    assertSameOrigin(req);
    const rt = await runtime();
    const services = requireServices(rt);
    const owner = await requireStaff(req, rt);
    const form = await req.formData();
    formTitle = String(form.get("title") ?? "");
    scaleConfirmed = form.get("scaleConfirmed") === "on" || form.get("scaleConfirmed") === "true";
    const mockup = form.get("mockup");
    const vector = form.get("vector");
    if (!(mockup instanceof File) || !(vector instanceof File)) throw new AppError("missing_file", "Cần đủ ảnh mockup và file vector.", 422);
    const job = await services.createJob({
      ownerId: owner,
      title: formTitle,
      scaleConfirmed,
      idempotencyKey: req.headers.get("idempotency-key"),
      mockup: { filename: mockup.name, bytes: Buffer.from(await mockup.arrayBuffer()) },
      vector: { filename: vector.name, bytes: Buffer.from(await vector.arrayBuffer()) },
    });
    if (wantsHtml(req)) return redirect(req, `/jobs/${job.id}`);
    const assets = await rt.store!.listAssets(job.id);
    return Response.json(presentJob(job, assets), { status: 201 });
  } catch (error) {
    if (wantsHtml(req) && isAppError(error)) {
      return redirect(req, `/jobs/new?${newJobRetryQuery(error.code, formTitle, scaleConfirmed)}`);
    }
    return errorResponse(error);
  }
}

export async function handleJobGet(req: Request, jobId: string): Promise<Response> {
  try {
    const rt = await runtime();
    const services = requireServices(rt);
    const owner = await requireStaff(req, rt);
    const job = await services.owned(owner, jobId);
    const assets = await rt.store!.listAssets(job.id);
    return Response.json(presentJob(job, assets));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePatterns(req: Request, jobId: string): Promise<Response> {
  try {
    assertSameOrigin(req);
    const rt = await runtime();
    const services = requireServices(rt);
    const owner = await requireStaff(req, rt);
    const form = await req.formData();
    const patterns: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (key.startsWith("pattern_") && typeof value === "string") patterns[key.slice("pattern_".length)] = value;
    }
    const job = await services.assignPatterns(owner, jobId, patterns);
    if (wantsHtml(req)) return redirect(req, `/jobs/${job.id}`);
    return Response.json(presentJob(job, await rt.store!.listAssets(job.id)));
  } catch (error) {
    if (wantsHtml(req) && isAppError(error)) return redirect(req, `/jobs/${jobId}?error=${error.code}`);
    return errorResponse(error);
  }
}

export async function handleDispatch(req: Request, jobId: string): Promise<Response> {
  try {
    assertSameOrigin(req);
    const rt = await runtime();
    const services = requireServices(rt);
    const owner = await requireStaff(req, rt);
    const result = await services.dispatch(owner, jobId);
    const view = presentJob(result.job, await rt.store!.listAssets(result.job.id));
    if (wantsHtml(req)) return redirect(req, `/jobs/${jobId}?notice=${result.job.status}`);
    const ok = result.job.status === "dispatched" || result.replay;
    return Response.json({ ...view, posted: result.posted, replay: result.replay }, { status: ok ? 200 : 409 });
  } catch (error) {
    if (wantsHtml(req) && isAppError(error)) return redirect(req, `/jobs/${jobId}?error=${error.code}`);
    return errorResponse(error);
  }
}

export async function handleHandoff(req: Request, jobId: string): Promise<Response> {
  try {
    assertSameOrigin(req);
    const rt = await runtime();
    const services = requireServices(rt);
    const owner = await requireStaff(req, rt);
    const job = await services.manualHandoff(owner, jobId);
    const view = presentJob(job, await rt.store!.listAssets(job.id));
    if (wantsHtml(req)) return redirect(req, `/jobs/${jobId}?notice=manual_handoff`);
    return Response.json(view);
  } catch (error) {
    if (wantsHtml(req) && isAppError(error)) return redirect(req, `/jobs/${jobId}?error=${error.code}`);
    return errorResponse(error);
  }
}

export async function handleStaffFile(req: Request, jobId: string, assetId: string): Promise<Response> {
  try {
    const rt = await runtime();
    const services = requireServices(rt);
    const owner = await requireStaff(req, rt);
    const asset = await services.ownedAsset(owner, jobId, assetId);
    return fileResponse(asset);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleSignedFile(req: Request, assetId: string): Promise<Response> {
  try {
    const rt = await runtime();
    const services = requireServices(rt);
    const url = new URL(req.url);
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    const asset = await services.signedAsset(assetId, exp, sig);
    return fileResponse(asset);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleArtifactUpload(req: Request, jobId: string, grantId: string): Promise<Response> {
  try {
    const rt = await runtime();
    const services = requireServices(rt);
    const url = new URL(req.url);
    if (url.searchParams.has("url") || url.searchParams.has("artifactUrl")) {
      throw new AppError("url_fetch_forbidden", "Server không tải artifact từ URL.", 400);
    }
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      throw new AppError("url_fetch_forbidden", "Hãy POST đúng byte của file. Server không nhận URL.", 415);
    }
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > 32 * 1024 * 1024) throw new AppError("file_too_large", "Artifact quá lớn.", 413);
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer ([!-~]+)$/.exec(header);
    if (!match) throw new AppError("grant_invalid", "Thiếu upload grant.", 401);
    const filename = req.headers.get("x-filename") ?? "artifact.bin";
    const bytes = Buffer.from(await req.arrayBuffer());
    const asset = await services.acceptArtifact({ jobId, grantId, grantToken: match[1], bytes, filename });
    return Response.json({ id: asset.id, kind: asset.kind, byteSize: asset.byteSize }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleMcp(req: Request): Promise<Response> {
  const rt = await runtime();
  return handleMcpHttp(req, rt);
}

function fileResponse(asset: { bytes: Buffer; mediaType: string; filename: string }): Response {
  const inline = asset.mediaType === "image/png" || asset.mediaType === "image/jpeg" || asset.mediaType === "image/webp";
  const type = asset.mediaType === "image/svg+xml" || asset.mediaType === "application/illustrator" ? "application/octet-stream" : asset.mediaType;
  const filename = asset.filename.replace(/["\r\n]/g, "");
  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "content-type": type,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
