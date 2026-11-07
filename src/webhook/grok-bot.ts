import webhookSpec from "@/spec/grok-bot-webhook.v1.json";
import { AppError } from "@/domain/errors";

export const WEBHOOK_SPEC = webhookSpec;

export type DispatchPayload = {
  contract: typeof webhookSpec.applicationPayload.contract;
  event: typeof webhookSpec.applicationPayload.event;
  jobId: string;
  specVersion: string;
  mcpUrl: string;
};

export function buildDispatchPayload(input: { jobId: string; specVersion: string; appOrigin: string }): DispatchPayload {
  const origin = input.appOrigin.replace(/\/$/, "");
  return {
    contract: webhookSpec.applicationPayload.contract,
    event: webhookSpec.applicationPayload.event,
    jobId: input.jobId,
    specVersion: input.specVersion,
    mcpUrl: `${origin}/api/mcp`,
  };
}

export function assertWebhookTarget(url: string, key: string, allowInsecure: boolean): URL {
  if (key !== key.trim() || /[\r\n]/.test(key) || key.trim().length < 8) {
    throw new AppError("webhook_key_invalid", "GROK_BOT_WEBHOOK_KEY is missing, short, or contains a newline.", 503);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("webhook_url_invalid", "GROK_BOT_WEBHOOK_URL is not a URL.", 503);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError("webhook_url_invalid", "GROK_BOT_WEBHOOK_URL must not contain credentials, a query, or a fragment.", 503);
  }
  const httpsOk = parsed.protocol === "https:";
  const httpTestOk = allowInsecure && parsed.protocol === "http:";
  if (!httpsOk && !httpTestOk) {
    throw new AppError("webhook_url_invalid", "GROK_BOT_WEBHOOK_URL must be https.", 503);
  }
  return parsed;
}

export async function postGrokBotWebhook(input: {
  url: string;
  key: string;
  allowInsecure: boolean;
  payload: DispatchPayload;
  fetchImpl?: typeof fetch;
}): Promise<{ httpStatus: number; accepted: boolean }> {
  const target = assertWebhookTarget(input.url, input.key, input.allowInsecure);
  const forbidden = webhookSpec.applicationPayload.forbiddenKeys;
  for (const key of forbidden) {
    if (key in input.payload) {
      throw new AppError("webhook_payload_invalid", "Dispatch payload contains a forbidden field.", 500);
    }
  }
  const body = JSON.stringify(input.payload);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(target, {
      method: webhookSpec.documented.method,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${input.key.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "clone-file-vai/applique-layout-1",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError("webhook_unreachable", "The webhook request failed before a status came back. The job was not completed.", 502);
  }
  await response.arrayBuffer().catch(() => undefined);
  return {
    httpStatus: response.status,
    accepted: response.status === webhookSpec.documented.successStatus,
  };
}
