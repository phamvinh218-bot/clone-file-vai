import { hashPassword } from "@/domain/password";
import { JobService } from "@/jobs/service";
import { loadConfig, setupGates, type AppConfig, type Gate } from "@/server/config";
import { openStore } from "@/store/open";
import type { Store } from "@/store/types";
import { randomUUID } from "node:crypto";

export type Runtime = {
  config: AppConfig;
  store: Store | null;
  storeError: string | null;
  services: JobService | null;
  gates: Gate[];
};

let current: Runtime | null = null;

export function setRuntimeForTests(runtime: Runtime | null) {
  current = runtime;
}

export function getRuntime(): Runtime {
  if (!current) throw new Error("Runtime has not booted");
  return current;
}

export async function getRequestRuntime(): Promise<Runtime> {
  if (current) return current;
  return bootRuntime();
}

export function createRuntime(env: NodeJS.ProcessEnv, overrides?: { store?: Store; now?: () => number; fetchImpl?: typeof fetch }): Runtime {
  const config = loadConfig(env);
  const store: Store | null = overrides?.store ?? null;
  let storeError: string | null = null;
  if (!store) {
    try {
      // openStore is async; local SQLite open is synchronous inside the promise.
      // The runtime is built lazily via createRuntimeAsync for the server.
      storeError = "Call createRuntimeAsync";
    } catch (error) {
      storeError = error instanceof Error ? error.message : "Store failed";
    }
  }
  const services = store ? new JobService(store, config, overrides?.now, overrides?.fetchImpl) : null;
  return {
    config,
    store,
    storeError,
    services,
    gates: setupGates(config, {
      storeReady: Boolean(store),
      storeDetail: store?.storageLabel ?? storeError ?? "Store is not open",
      userCount: null,
    }),
  };
}

export async function createRuntimeAsync(env: NodeJS.ProcessEnv, overrides?: { now?: () => number; fetchImpl?: typeof fetch }): Promise<Runtime> {
  const config = loadConfig(env);
  let store: Store | null = null;
  let storeError: string | null = null;
  try {
    store = await openStore(config);
    if (config.bootstrap && (await store.countUsers()) === 0) {
      await store.createUser({
        id: randomUUID(),
        email: config.bootstrap.email,
        passwordHash: hashPassword(config.bootstrap.password),
        createdAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    store = null;
    storeError = error instanceof Error ? error.message : "Store failed";
  }
  const userCount = store ? await store.countUsers() : null;
  const services = store ? new JobService(store, config, overrides?.now, overrides?.fetchImpl) : null;
  return {
    config,
    store,
    storeError,
    services,
    gates: setupGates(config, {
      storeReady: Boolean(store),
      storeDetail: store?.storageLabel ?? storeError ?? "Store is not open",
      userCount,
    }),
  };
}

let boot: Promise<Runtime> | null = null;

export function bootRuntime(): Promise<Runtime> {
  if (!boot) {
    boot = createRuntimeAsync(process.env).then((runtime) => {
      current = runtime;
      return runtime;
    });
  }
  return boot;
}
