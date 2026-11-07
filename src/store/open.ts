import { AppError } from "@/domain/errors";
import type { AppConfig } from "@/server/config";
import { createMemoryStore } from "@/store/memory";
import { openSqliteStore } from "@/store/sqlite";
import type { Store } from "@/store/types";

export async function openStore(config: AppConfig): Promise<Store> {
  if (config.driverRejected) {
    throw new AppError("not_configured", "STORE_DRIVER is not recognized. Leave it unset to use local SQLite.", 503);
  }
  if (config.storeDriver === "sqlite") return openSqliteStore(config.dataDir);
  if (config.storeDriver === "memory-mock") {
    if (config.nodeEnv === "production" || config.memoryStoreAck !== "test-only") {
      throw new AppError(
        "not_configured",
        "STORE_DRIVER=memory-mock is a labeled test double. It boots only with MEMORY_STORE_ACK=test-only outside production.",
        503,
      );
    }
    return createMemoryStore();
  }
  throw new AppError(
    "not_configured",
    "STORE_DRIVER=postgres is a reserved future adapter. No cloud database is provisioned. Unset STORE_DRIVER to use the local SQLite file.",
    503,
  );
}
