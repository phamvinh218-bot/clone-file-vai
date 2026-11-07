import { loadConfig } from "@/server/config";
import { openStore } from "@/store/open";

const CONFIG_NAMES = [
  "DATA_DIR",
  "SESSION_SECRET",
  "ASSET_SIGNING_SECRET",
  "BOT_WORKER_TOKEN",
  "APP_ORIGIN",
  "STAFF_BOOTSTRAP_EMAIL",
  "STAFF_BOOTSTRAP_PASSWORD",
] as const;

export type AccountStatus = {
  storeOpen: boolean;
  userCount: number | null;
  bootstrapEmailPresent: boolean;
  bootstrapPasswordPresent: boolean;
  bootstrapValid: boolean;
  bootstrapInvalid: boolean;
  startupCreatesUser: boolean;
  startupChangesExistingPassword: false;
  configPresent: Record<(typeof CONFIG_NAMES)[number], boolean>;
};

export async function diagnoseAccounts(env: NodeJS.ProcessEnv): Promise<AccountStatus> {
  const config = loadConfig(env);
  const configPresent = Object.fromEntries(CONFIG_NAMES.map((name) => [name, Boolean(env[name]?.toString().trim())])) as AccountStatus["configPresent"];
  let storeOpen = false;
  let userCount: number | null = null;
  try {
    const store = await openStore(config);
    try {
      storeOpen = true;
      userCount = await store.countUsers();
    } finally {
      await store.close();
    }
  } catch {
    storeOpen = false;
    userCount = null;
  }
  return {
    storeOpen,
    userCount,
    bootstrapEmailPresent: configPresent.STAFF_BOOTSTRAP_EMAIL,
    bootstrapPasswordPresent: configPresent.STAFF_BOOTSTRAP_PASSWORD,
    bootstrapValid: Boolean(config.bootstrap),
    bootstrapInvalid: config.bootstrapInvalid,
    startupCreatesUser: Boolean(config.bootstrap) && userCount === 0,
    startupChangesExistingPassword: false,
    configPresent,
  };
}
