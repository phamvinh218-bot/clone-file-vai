import { loadEnvConfig } from "@next/env";
import { diagnoseAccounts } from "@/account/diagnose";
import { assertLocalAccountCommand } from "@/account/local-guard";

async function main() {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  try {
    assertLocalAccountCommand(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Account status refused.");
    process.exit(1);
  }
  const status = await diagnoseAccounts(process.env);
  console.log(JSON.stringify(status, null, 2));
}

main().catch(() => {
  console.error("Account status failed.");
  process.exit(1);
});
