import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobService } from "@/jobs/service";
import { loadConfig } from "@/server/config";
import { setupGates } from "@/server/config";
import type { Runtime } from "@/server/runtime";
import { openStore } from "@/store/open";
import type { Store } from "@/store/types";

export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export const TWO_PIECE_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="40mm" viewBox="0 0 100 40"><rect x="5" y="5" width="30" height="20"/><rect x="50" y="8" width="20" height="25"/></svg>`,
);

export function clock(start = Date.parse("2026-01-01T00:00:00.000Z")) {
  const state = { ms: start };
  return {
    state,
    now: () => state.ms,
  };
}

export async function openTestRuntime(driver: "memory-mock" | "sqlite", options?: { now?: () => number; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }) {
  const dir = mkdtempSync(path.join(tmpdir(), "cfv-"));
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    STORE_DRIVER: driver,
    MEMORY_STORE_ACK: "test-only",
    DATA_DIR: dir,
    SESSION_SECRET: "staff-session-secret-for-tests-32",
    ASSET_SIGNING_SECRET: "asset-signing-secret-for-tests-32",
    BOT_WORKER_TOKEN: "bot-worker-token-for-tests-32chars",
    APP_ORIGIN: "http://127.0.0.1:3000",
    ...options?.env,
  };
  const config = loadConfig(env);
  const store = await openStore(config);
  const services = new JobService(store, config, options?.now ?? Date.now, options?.fetchImpl);
  const runtime: Runtime = {
    config,
    store,
    storeError: null,
    services,
    gates: setupGates(config, { storeReady: true, storeDetail: store.storageLabel, userCount: 0 }),
  };
  return {
    dir,
    env,
    runtime,
    services,
    store,
    async close() {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestRuntime = Awaited<ReturnType<typeof openTestRuntime>>;

export async function staff(services: JobService, email: string) {
  return services.registerStaff(email, "local-password-12");
}

export function storageNote(store: Store): string {
  return `${store.driverName}: ${store.storageLabel}`;
}
