import { describe, expect, it } from "vitest";
import { handleMcpHttp, toolDefinitions } from "@/mcp/handler";
import toolSpec from "@/spec/mcp-tools.v1.json";
import { setRuntimeForTests } from "@/server/runtime";
import { openTestRuntime, staff, TINY_PNG, TWO_PIECE_SVG } from "@/test/fixture";
import { handleArtifactUpload, handleJobGet, handleLogin } from "@/http/handlers";

const MCP_ACCEPT = "application/json, text/event-stream";

describe("MCP handshake", () => {
  it("matches the versioned tool contract and refuses staff cookies", async () => {
    const names = toolDefinitions().map((tool) => tool.name);
    expect(names).toEqual(toolSpec.tools.map((tool) => tool.name));
    for (const tool of toolSpec.tools) {
      const defined = toolDefinitions().find((item) => item.name === tool.name);
      expect(defined?.inputSchema.required).toEqual(tool.required);
    }
    const ctx = await openTestRuntime("sqlite");
    setRuntimeForTests(ctx.runtime);
    try {
      const missing = await handleMcpHttp(new Request("http://127.0.0.1:3000/api/mcp"), ctx.runtime);
      expect(missing.status).toBe(405);
      const bare = await handleMcpHttp(
        new Request("http://127.0.0.1:3000/api/mcp", { method: "POST", headers: { accept: MCP_ACCEPT }, body: "{}" }),
        ctx.runtime,
      );
      expect(bare.status).toBe(401);
      const noAccept = await handleMcpHttp(
        new Request("http://127.0.0.1:3000/api/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${ctx.env.BOT_WORKER_TOKEN}`, accept: "application/json" },
          body: "{}",
        }),
        ctx.runtime,
      );
      expect(noAccept.status).toBe(406);
      const vinh = await staff(ctx.services, "vinh@xuong.local");
      const login = await handleLogin(
        new Request("http://127.0.0.1:3000/api/session", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:3000", accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ email: "vinh@xuong.local", password: "local-password-12" }),
        }),
      );
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie") ?? "";
      const withCookie = await handleMcpHttp(
        new Request("http://127.0.0.1:3000/api/mcp", {
          method: "POST",
          headers: { accept: MCP_ACCEPT, cookie, origin: "http://127.0.0.1:3000" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
        }),
        ctx.runtime,
      );
      expect(withCookie.status).toBe(401);
      const rpc = (method: string, params: unknown, id: number) =>
        handleMcpHttp(
          new Request("http://127.0.0.1:3000/api/mcp", {
            method: "POST",
            headers: {
              accept: MCP_ACCEPT,
              authorization: `Bearer ${ctx.env.BOT_WORKER_TOKEN}`,
              "content-type": "application/json",
              "mcp-protocol-version": "2025-06-18",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          }),
          ctx.runtime,
        );
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }, 1);
      expect(init.status).toBe(200);
      const initBody = await init.json();
      expect(initBody.result.protocolVersion).toBe("2025-06-18");
      expect(initBody.result.serverInfo.name).toBe("clone-file-vai");
      const listed = await rpc("tools/list", {}, 2);
      const listedBody = await listed.json();
      expect(listedBody.result.tools.map((tool: { name: string }) => tool.name)).toEqual(names);
      const job = await ctx.services.createJob({
        ownerId: vinh.id,
        title: "MCP",
        scaleConfirmed: true,
        mockup: { filename: "mock.png", bytes: TINY_PNG },
        vector: { filename: "cut.svg", bytes: TWO_PIECE_SVG },
      });
      const other = await handleJobGet(
        new Request("http://127.0.0.1:3000/api/jobs/" + job.id, { headers: { authorization: `Bearer ${ctx.env.BOT_WORKER_TOKEN}` } }),
        job.id,
      );
      expect(other.status).toBe(401);
      const lan = await staff(ctx.services, "lan@xuong.local");
      const lanLogin = await handleLogin(
        new Request("http://127.0.0.1:3000/api/session", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:3000", accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ email: lan.email, password: "local-password-12" }),
        }),
      );
      const lanCookie = lanLogin.headers.get("set-cookie") ?? "";
      const cross = await handleJobGet(new Request("http://127.0.0.1:3000/api/jobs/" + job.id, { headers: { cookie: lanCookie } }), job.id);
      expect(cross.status).toBe(404);
      const badUpload = await handleArtifactUpload(
        new Request(`http://127.0.0.1:3000/api/jobs/${job.id}/artifact-uploads/grant`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ctx.env.BOT_WORKER_TOKEN}` },
          body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
        }),
        job.id,
        "grant",
      );
      expect(badUpload.status).toBe(415);
      const badBody = await badUpload.json();
      expect(badBody.error).toBe("url_fetch_forbidden");
    } finally {
      setRuntimeForTests(null);
      await ctx.close();
    }
  });
});
