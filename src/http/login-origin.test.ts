import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import { errorResponse, handleLogin, logSafeError } from "@/http/handlers";
import { setRuntimeForTests } from "@/server/runtime";
import { openTestRuntime, staff } from "@/test/fixture";

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

async function loginContext() {
  const ctx = await openTestRuntime("sqlite");
  await staff(ctx.services, "vinh@localhost");
  setRuntimeForTests(ctx.runtime);
  return ctx;
}

function loginRequest(headers: Record<string, string>, accept = HTML_ACCEPT) {
  return new Request("http://localhost:3000/api/session", {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost:3000",
      ...headers,
    },
    body: new URLSearchParams({ email: "vinh@localhost", password: "local-password-12" }),
  });
}

describe("login origin", () => {
  afterEach(() => setRuntimeForTests(null));

  it("keeps a real same-origin form login, including localhost while APP_ORIGIN is 127.0.0.1", async () => {
    const ctx = await loginContext();
    try {
      const response = await handleLogin(loginRequest({ "sec-fetch-site": "same-origin" }));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/jobs");
      expect(response.headers.get("set-cookie") ?? "").toContain("cfv_session=");
    } finally {
      await ctx.close();
    }
  });

  it("rejects the literal Origin null without a 500 and sends the browser back to login", async () => {
    const ctx = await loginContext();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleLogin(loginRequest({ origin: "null", "sec-fetch-site": "same-origin" }));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://localhost:3000/login?error=origin_opaque");
      expect(spy).not.toHaveBeenCalled();
      const jsonClient = await handleLogin(
        loginRequest({ origin: "null" }, "application/json"),
      );
      expect(jsonClient.status).toBe(403);
      expect(await jsonClient.json()).toMatchObject({ error: "origin_opaque" });
    } finally {
      spy.mockRestore();
      await ctx.close();
    }
  });

  it("rejects a malformed Origin without throwing", async () => {
    const ctx = await loginContext();
    try {
      const response = await handleLogin(loginRequest({ origin: "http://[" }));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("error=origin_invalid");
    } finally {
      await ctx.close();
    }
  });

  it("allows a missing Origin for a non-browser client and forbids cross-site", async () => {
    const ctx = await loginContext();
    try {
      const missing = await handleLogin(loginRequest({ origin: "" }));
      expect(missing.status).toBe(303);
      expect(missing.headers.get("location")).toBe("http://localhost:3000/jobs");

      const cross = await handleLogin(loginRequest({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }));
      expect(cross.status).toBe(303);
      expect(cross.headers.get("location")).toContain("error=csrf");

      const spoofedSite = await handleLogin(
        loginRequest({ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" }),
      );
      expect(spoofedSite.headers.get("location")).toContain("error=csrf");
    } finally {
      await ctx.close();
    }
  });

  it("does not print request input when an unexpected error is logged", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const secret = "local-password-12";
      logSafeError(Object.assign(new Error(`bad ${secret}`), { code: "ERR_TEST" }));
      const logged = spy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("ERR_TEST");
      expect(logged).not.toContain(secret);
      const response = errorResponse(Object.assign(new Error(`bad ${secret}`), { code: "ERR_TEST" }));
      expect(response.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("referrer policy", () => {
  it("does not use no-referrer, which the Fetch standard turns into Origin null on form POST", async () => {
    const rules = await nextConfig.headers();
    const policy = rules.flatMap((rule) => rule.headers).find((header) => header.key === "Referrer-Policy");
    expect(policy?.value).toBe("strict-origin-when-cross-origin");
  });
});
