import { loadEnvConfig } from "@next/env";
import { resetStoredPassword } from "@/account/reset-password";
import { assertInteractiveTerminal, assertLocalAccountCommand, targetEmailFromArgv } from "@/account/local-guard";
import { loadConfig } from "@/server/config";
import { openStore } from "@/store/open";

async function main() {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  try {
    assertLocalAccountCommand(process.env);
    assertInteractiveTerminal(process.stdin, process.stdout);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Account reset refused.");
    process.exit(1);
  }

  let email: string;
  try {
    email = targetEmailFromArgv(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Account email refused.");
    process.exit(1);
  }

  const first = await readHiddenLine("New password (hidden): ");
  const second = await readHiddenLine("Repeat password (hidden): ");
  if (first !== second) {
    console.error("The two entries did not match. Nothing was changed.");
    process.exit(1);
  }

  const config = loadConfig(process.env);
  const store = await openStore(config);
  try {
    await resetStoredPassword(store, email, first);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Password was not changed.");
    process.exitCode = 1;
  } finally {
    await store.close();
  }
  if (process.exitCode) return;
  console.log(`Password updated for ${email}. Jobs and other accounts were not changed. Sign in with the new password. .env.local was not modified.`);
}

main().catch(() => {
  console.error("Account reset failed. Nothing was confirmed.");
  process.exit(1);
});

function readHiddenLine(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    const onData = (text: string) => {
      for (const ch of text) {
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Cancelled. Nothing was changed."));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          process.stdout.write("\n");
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}
