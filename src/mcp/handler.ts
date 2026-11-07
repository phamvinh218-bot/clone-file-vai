import toolSpec from "@/spec/mcp-tools.v1.json";
import { AppError, isAppError } from "@/domain/errors";
import { appearanceNote, type JobService } from "@/jobs/service";
import { secretsEqual } from "@/domain/sign";
import type { Runtime } from "@/server/runtime";

type Json = Record<string, unknown>;

const SUPPORTED = new Set(toolSpec.protocolVersions);

function schema(required: string[], optional: string[] = []) {
  const properties: Record<string, { type: string }> = {};
  for (const name of [...required, ...optional]) properties[name] = { type: "string" };
  return { type: "object", additionalProperties: false, properties, required };
}

const OPTIONAL: Record<string, string[]> = { claim_job: ["workerId"] };

export function toolDefinitions() {
  return toolSpec.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: schema(tool.required, OPTIONAL[tool.name] ?? []),
  }));
}

export function workerAuthorized(req: Request, runtime: Runtime): "ok" | "not_configured" | "unauthorized" {
  if (!runtime.config.botWorkerToken) return "not_configured";
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([!-~]+)$/.exec(header);
  if (!match || !secretsEqual(match[1], runtime.config.botWorkerToken)) return "unauthorized";
  return "ok";
}

export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

export async function handleMcpHttp(req: Request, runtime: Runtime): Promise<Response> {
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return Response.json({ error: "not_acceptable" }, { status: 406 });
  }
  if (!originAllowed(req)) return Response.json({ error: "origin_rejected" }, { status: 403 });
  const headerVersion = req.headers.get("mcp-protocol-version");
  if (headerVersion && !SUPPORTED.has(headerVersion)) {
    return Response.json({ error: "unsupported_protocol" }, { status: 400 });
  }
  const auth = workerAuthorized(req, runtime);
  if (auth === "not_configured") {
    return Response.json({ error: "not_configured", missing: ["BOT_WORKER_TOKEN"] }, { status: 503 });
  }
  if (auth !== "ok") {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="clone-file-vai"' },
    });
  }
  let message: unknown;
  try {
    message = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  if (Array.isArray(message)) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not supported" } }, { status: 400 });
  }
  const response = await handleMcpMessage(message, runtime);
  if (!response) return new Response(null, { status: 202 });
  return Response.json(response);
}

export async function handleMcpMessage(message: unknown, runtime: Runtime): Promise<Json | null> {
  if (!message || typeof message !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const body = message as { jsonrpc?: string; id?: unknown; method?: string; params?: Json };
  const hasId = Object.prototype.hasOwnProperty.call(body, "id");
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32600, message: "Invalid request" } };
  }
  if (!hasId) {
    if (body.method === "notifications/initialized" || body.method.startsWith("notifications/")) return null;
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Notification was not recognized" } };
  }
  try {
    const result = await dispatchMethod(body.method, body.params ?? {}, runtime);
    return { jsonrpc: "2.0", id: body.id ?? null, result };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "MCP error";
    const code = error instanceof AppError && error.code === "tool_not_found" ? -32602 : -32603;
    return { jsonrpc: "2.0", id: body.id ?? null, error: { code, message: messageText } };
  }
}

async function dispatchMethod(method: string, params: Json, runtime: Runtime): Promise<unknown> {
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return {
      protocolVersion: SUPPORTED.has(requested) ? requested : "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "clone-file-vai", version: "0.1.0" },
      instructions:
        "Use these tools for applique jobs. Do not fetch arbitrary URLs. Webhook HTTP 200 is only dispatch. Geometry is authoritative. " +
        appearanceNote(),
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: toolDefinitions() };
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Json;
    const known = toolSpec.tools.find((tool) => tool.name === name);
    if (!known) throw new AppError("tool_not_found", `Unknown tool ${name}`, 404);
    for (const key of Object.keys(args)) {
      const allowed = new Set([...known.required, ...(OPTIONAL[name] ?? [])]);
      if (!allowed.has(key)) {
        return toolResult({ error: "invalid_arguments", message: `Unexpected field ${key}` }, true);
      }
    }
    for (const key of known.required) {
      if (typeof args[key] !== "string" || !String(args[key]).trim()) {
        return toolResult({ error: "invalid_arguments", message: `Missing ${key}` }, true);
      }
    }
    return callTool(name, args, runtime);
  }
  throw new AppError("method_not_found", `Unsupported method ${method}`, 404);
}

async function callTool(name: string, args: Json, runtime: Runtime): Promise<unknown> {
  const services = runtime.services;
  if (!services) return toolResult({ error: "not_configured", message: "Store is not configured." }, true);
  try {
    const data = await runTool(name, args, services);
    return toolResult(data, false);
  } catch (error) {
    if (isAppError(error)) return toolResult({ error: error.code, message: error.message }, true);
    return toolResult({ error: "internal", message: "Tool failed." }, true);
  }
}

async function runTool(name: string, args: Json, services: JobService): Promise<unknown> {
  if (name === "list_jobs") {
    const jobs = await services.listActionable();
    return {
      jobs: jobs.map((job) => ({
        jobId: job.id,
        status: job.status,
        title: job.doc.title,
        specVersion: job.doc.specVersion,
        printReady: job.doc.printReady,
        leaseUntil: job.doc.lease?.until ?? null,
      })),
    };
  }
  if (name === "get_job") {
    const job = await services.workerGet(String(args.jobId));
    return {
      jobId: job.id,
      status: job.status,
      specVersion: job.doc.specVersion,
      printReady: job.doc.printReady,
      layout: job.doc.layout,
      pieces: job.doc.parse.pieces,
      patternByPieceId: job.doc.patternByPieceId,
      warnings: job.doc.warnings,
      artboard: job.doc.parse.artboard,
      hasPhysicalUnit: job.doc.parse.hasPhysicalUnit,
      lease: job.doc.lease,
      appearance: appearanceNote(),
      historicalAllowanceMm: 20,
      allowanceMmEachSide: 10,
    };
  }
  if (name === "claim_job") return services.claim(String(args.jobId), String(args.workerId ?? "grok-bot"));
  if (name === "create_source_download") return services.createSourceDownload(String(args.jobId), String(args.assetId));
  if (name === "create_artifact_upload") {
    return services.createArtifactUpload(String(args.jobId), String(args.leaseId), String(args.artifactKind));
  }
  if (name === "complete_job") {
    return services.complete(String(args.jobId), String(args.leaseId), String(args.idempotencyKey));
  }
  if (name === "fail_job") {
    return services.fail(String(args.jobId), String(args.leaseId), String(args.idempotencyKey), String(args.code), String(args.message));
  }
  throw new AppError("tool_not_found", name, 404);
}

function toolResult(data: unknown, isError: boolean) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError };
}
