import { LIMITS } from "@/domain/limits";

export type StoreDriver = "sqlite" | "memory-mock" | "postgres";

export type AppConfig = {
  nodeEnv: string;
  dataDir: string;
  storeDriver: StoreDriver;
  driverRejected: boolean;
  memoryStoreAck: string | null;
  sessionSecret: string | null;
  assetSigningSecret: string | null;
  botWorkerToken: string | null;
  webhook: { url: string; key: string } | null;
  webhookKeyInvalid: boolean;
  webhookPartial: boolean;
  webhookAllowInsecure: boolean;
  appOrigin: string | null;
  bootstrap: { email: string; password: string } | null;
  bootstrapInvalid: boolean;
  leaseSeconds: number;
  maxAttempts: number;
};

export type Gate = { name: string; ok: boolean; detail: string };

function readableSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value !== value.trim() || /[\r\n]/.test(value)) return null;
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const driverRaw = (env.STORE_DRIVER ?? "sqlite").trim();
  const known = driverRaw === "sqlite" || driverRaw === "memory-mock" || driverRaw === "postgres";
  const sessionSecret = readableSecret(env.SESSION_SECRET);
  const assetSigningSecret = readableSecret(env.ASSET_SIGNING_SECRET);
  const botWorkerToken = readableSecret(env.BOT_WORKER_TOKEN);
  const webhookUrl = env.GROK_BOT_WEBHOOK_URL?.trim() ?? "";
  const webhookKeyRaw = env.GROK_BOT_WEBHOOK_KEY ?? "";
  const webhookKeyInvalid =
    webhookKeyRaw.length > 0 && (webhookKeyRaw !== webhookKeyRaw.trim() || /[\r\n]/.test(webhookKeyRaw) || webhookKeyRaw.trim().length < 8);
  const webhookKey = webhookKeyInvalid ? "" : webhookKeyRaw.trim();
  const email = env.STAFF_BOOTSTRAP_EMAIL?.trim().toLowerCase() ?? "";
  const password = env.STAFF_BOOTSTRAP_PASSWORD ?? "";
  const bootstrapInvalid = Boolean(email || password) && (!email.includes("@") || password.trim().length < LIMITS.passwordMin);
  const leaseRaw = Number(env.JOB_LEASE_SECONDS ?? LIMITS.leaseSecondsDefault);
  return {
    nodeEnv,
    dataDir: env.DATA_DIR?.trim() || "./data",
    storeDriver: known ? driverRaw : "sqlite",
    driverRejected: !known,
    memoryStoreAck: env.MEMORY_STORE_ACK ?? null,
    sessionSecret: sessionSecret && sessionSecret.length >= LIMITS.secretMin ? sessionSecret : null,
    assetSigningSecret: assetSigningSecret && assetSigningSecret.length >= LIMITS.secretMin ? assetSigningSecret : null,
    botWorkerToken: botWorkerToken && botWorkerToken.length >= LIMITS.secretMin ? botWorkerToken : null,
    webhook: webhookUrl && webhookKey ? { url: webhookUrl, key: webhookKey } : null,
    webhookKeyInvalid,
    webhookPartial: Boolean(webhookUrl) !== Boolean(webhookKey),
    webhookAllowInsecure: nodeEnv !== "production" && env.GROK_BOT_WEBHOOK_ALLOW_INSECURE === "test",
    appOrigin: env.APP_ORIGIN?.trim() || null,
    bootstrap: email && password && !bootstrapInvalid ? { email, password } : null,
    bootstrapInvalid,
    leaseSeconds: Number.isFinite(leaseRaw) && leaseRaw >= 30 ? leaseRaw : LIMITS.leaseSecondsDefault,
    maxAttempts: LIMITS.maxLeaseAttempts,
  };
}

export function setupGates(
  config: AppConfig,
  extras: { storeReady: boolean; storeDetail: string; userCount: number | null },
): Gate[] {
  return [
    {
      name: "STORE_DRIVER",
      ok: !config.driverRejected && config.storeDriver === "sqlite" && extras.storeReady,
      detail: config.storeDriver === "postgres"
        ? "postgres is reserved and not provisioned. Leave STORE_DRIVER unset to use local SQLite."
        : extras.storeDetail,
    },
    {
      name: "DATA_DIR",
      ok: config.storeDriver === "sqlite" && extras.storeReady,
      detail: "Durable local directory for the SQLite file and private blobs. Not the web root.",
    },
    {
      name: "SESSION_SECRET",
      ok: Boolean(config.sessionSecret),
      detail: "Staff session signer. Minimum 32 characters. Not the bot token.",
    },
    {
      name: "ASSET_SIGNING_SECRET",
      ok: Boolean(config.assetSigningSecret),
      detail: "HMAC key for short-lived source download URLs.",
    },
    {
      name: "BOT_WORKER_TOKEN",
      ok: Boolean(config.botWorkerToken),
      detail: "Bearer token for /api/mcp. Staff cookies are rejected there.",
    },
    {
      name: "APP_ORIGIN",
      ok: Boolean(config.appOrigin),
      detail: "Public https origin later. http://127.0.0.1 is local only and blocks real dispatch.",
    },
    {
      name: "GROK_BOT_WEBHOOK_URL",
      ok: !config.webhookPartial && !config.webhookKeyInvalid,
      detail: config.webhook
        ? "Server-only routine URL is set. HTTP 200 means the run started, not that the job finished."
        : "Optional. Leave empty, together with the key, until a routine exists.",
    },
    {
      name: "GROK_BOT_WEBHOOK_KEY",
      ok: !config.webhookPartial && !config.webhookKeyInvalid,
      detail: config.webhookKeyInvalid
        ? "Key is empty, short, or contains a newline. Fix it before dispatch."
        : "Server-only bearer key. It is never returned to the browser. Both URL and key must be set together.",
    },
    {
      name: "STAFF_BOOTSTRAP_EMAIL",
      ok: !config.bootstrapInvalid && (extras.userCount === null || extras.userCount > 0 || Boolean(config.bootstrap)),
      detail: "Creates the first staff user only when the user table is empty.",
    },
  ];
}
