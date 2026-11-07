import { isPublicHttpsOrigin } from "@/domain/origin";

/** Local sqlite maintenance only. Production and public origins are refused even if the flag is set. */
export function assertLocalAccountCommand(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing account command because NODE_ENV is production.");
  }
  if (env.ACCOUNT_LOCAL !== "1") {
    throw new Error("Refusing account command. Set ACCOUNT_LOCAL=1 only for this local workshop database.");
  }
  if ((env.STORE_DRIVER ?? "sqlite").trim() !== "sqlite") {
    throw new Error("Account command only opens the local sqlite store.");
  }
  const origin = env.APP_ORIGIN?.trim() ?? "";
  if (origin && isPublicHttpsOrigin(origin)) {
    throw new Error("Refusing account command because APP_ORIGIN is a public https origin.");
  }
}

export function targetEmailFromArgv(argv: string[]): string {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  if (args.length !== 1 || args[0].startsWith("-") || args[0].includes("=")) {
    throw new Error("Pass exactly one account email. Do not pass a password.");
  }
  const email = args[0].trim().toLowerCase();
  if (!email.includes("@") || email.length > 200) throw new Error("The account email is not valid.");
  return email;
}

export function assertInteractiveTerminal(stdin: { isTTY?: boolean }, stdout: { isTTY?: boolean }): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("The password prompt only runs in an interactive terminal. Do not pass or pipe a password.");
  }
}
