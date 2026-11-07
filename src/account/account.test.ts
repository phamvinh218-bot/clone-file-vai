import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnoseAccounts } from "@/account/diagnose";
import { assertInteractiveTerminal, assertLocalAccountCommand, targetEmailFromArgv } from "@/account/local-guard";
import { resetStoredPassword } from "@/account/reset-password";
import { AppError } from "@/domain/errors";
import { setupGates, loadConfig } from "@/server/config";
import { createRuntimeAsync } from "@/server/runtime";
import { openTestRuntime } from "@/test/fixture";

const FIRST = "initial-password-1";
const CHANGED = "changed-password-2";
const OTHER = "other-account-pass";
const RESET = "reset-password-03";

function env(dir: string, password: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    STORE_DRIVER: "sqlite",
    DATA_DIR: dir,
    SESSION_SECRET: "s".repeat(32),
    ASSET_SIGNING_SECRET: "a".repeat(32),
    BOT_WORKER_TOKEN: "b".repeat(32),
    APP_ORIGIN: "http://127.0.0.1:3000",
    STAFF_BOOTSTRAP_EMAIL: "vinh@localhost",
    STAFF_BOOTSTRAP_PASSWORD: password,
    ACCOUNT_LOCAL: "1",
    ...extra,
  };
}

describe("bootstrap does not rewrite an existing password", () => {
  it("creates the first user, then ignores a later env password", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfv-boot-"));
    const first = await createRuntimeAsync(env(dir, FIRST));
    expect(await first.store!.countUsers()).toBe(1);
    await expect(first.services!.login("vinh@localhost", FIRST)).resolves.toMatchObject({ email: "vinh@localhost" });
    await expect(first.services!.login("vinh@localhost", CHANGED)).rejects.toMatchObject({ code: "invalid_login" });
    await first.store!.close();

    const second = await createRuntimeAsync(env(dir, CHANGED));
    expect(await second.store!.countUsers()).toBe(1);
    await expect(second.services!.login("vinh@localhost", FIRST)).resolves.toMatchObject({ email: "vinh@localhost" });
    await expect(second.services!.login("vinh@localhost", CHANGED)).rejects.toMatchObject({ code: "invalid_login" });
    const gate = second.gates.find((item) => item.name === "STAFF_BOOTSTRAP_EMAIL");
    expect(gate?.ok).toBe(true);
    expect(gate?.detail).toMatch(/does not change that password/);
    await second.store!.close();
  });

  it("trims a carriage return only for a new bootstrap, and reports a missing bootstrap when no user exists", async () => {
    const empty = loadConfig({ NODE_ENV: "test" });
    const missing = setupGates(empty, { storeReady: true, storeDetail: "sqlite", userCount: 0 }).find((gate) => gate.name === "STAFF_BOOTSTRAP_EMAIL");
    expect(missing?.ok).toBe(false);

    const dir = mkdtempSync(path.join(tmpdir(), "cfv-cr-"));
    const created = await createRuntimeAsync(env(dir, `${FIRST}\r`));
    await expect(created.services!.login("vinh@localhost", FIRST)).resolves.toMatchObject({ email: "vinh@localhost" });
    await created.store!.close();
  });
});

describe("local password reset", () => {
  for (const driver of ["memory-mock", "sqlite"] as const) {
    it(`updates only the named account on ${driver} and keeps jobs`, async () => {
      const ctx = await openTestRuntime(driver);
      try {
        const vinh = await ctx.services.registerStaff("vinh@localhost", FIRST);
        const lan = await ctx.services.registerStaff("lan@localhost", OTHER);
        const lanBefore = await ctx.store.getUser(lan.id);
        await ctx.store.insertJob({
          id: "11111111-1111-4111-8111-111111111111",
          ownerId: vinh.id,
          status: "ready",
          rev: 1,
          doc: { title: "keep" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        await resetStoredPassword(ctx.store, "vinh@localhost", RESET);
        await expect(ctx.services.login("vinh@localhost", RESET)).resolves.toMatchObject({ id: vinh.id });
        await expect(ctx.services.login("vinh@localhost", FIRST)).rejects.toBeInstanceOf(AppError);
        await expect(ctx.services.login("lan@localhost", OTHER)).resolves.toMatchObject({ id: lan.id });
        expect((await ctx.store.getUser(lan.id))?.passwordHash).toBe(lanBefore?.passwordHash);
        expect((await ctx.store.getJob("11111111-1111-4111-8111-111111111111"))?.doc).toMatchObject({ title: "keep" });
        await expect(resetStoredPassword(ctx.store, "missing@localhost", RESET)).rejects.toMatchObject({ code: "not_found" });
      } finally {
        await ctx.close();
      }
    });
  }
});

describe("account command guards and diagnosis", () => {
  it("refuses production, public origins, and password arguments", () => {
    expect(() => assertLocalAccountCommand({ NODE_ENV: "production", ACCOUNT_LOCAL: "1" })).toThrow(/production/);
    expect(() => assertLocalAccountCommand({ NODE_ENV: "development", APP_ORIGIN: "http://127.0.0.1:3000" })).toThrow(/ACCOUNT_LOCAL/);
    expect(() => assertLocalAccountCommand({ NODE_ENV: "development", ACCOUNT_LOCAL: "1", APP_ORIGIN: "https://xuong.example" })).toThrow(/public/);
    expect(() => assertLocalAccountCommand({ NODE_ENV: "development", ACCOUNT_LOCAL: "1", STORE_DRIVER: "postgres" })).toThrow(/sqlite/);
    expect(() => targetEmailFromArgv(["node", "reset", "vinh@localhost", "--password", FIRST])).toThrow(/password/);
    expect(targetEmailFromArgv(["node", "reset", "--", "Vinh@LocalHost"])).toBe("vinh@localhost");
    expect(() => assertInteractiveTerminal({ isTTY: false }, { isTTY: true })).toThrow(/interactive/);
  });

  it("reports counts and config presence without secrets", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfv-status-"));
    const runtime = await createRuntimeAsync(env(dir, FIRST));
    await runtime.store!.close();
    const status = await diagnoseAccounts(env(dir, FIRST));
    expect(status.userCount).toBe(1);
    expect(status.startupCreatesUser).toBe(false);
    expect(status.startupChangesExistingPassword).toBe(false);
    expect(status.configPresent.STAFF_BOOTSTRAP_EMAIL).toBe(true);
    expect(status.configPresent.SESSION_SECRET).toBe(true);
    const printed = JSON.stringify(status);
    expect(printed).not.toContain(FIRST);
    expect(printed).not.toContain("s".repeat(32));
    expect(printed).not.toContain("passwordHash");
  });
});
