import { createInterface } from "node:readline";
import { handleMcpMessage } from "@/mcp/handler";
import { createRuntimeAsync } from "@/server/runtime";

async function main() {
  const runtime = await createRuntimeAsync(process.env);
  if (!runtime.config.botWorkerToken || !runtime.services) {
    process.stderr.write("mcp stdio refused: BOT_WORKER_TOKEN or local store is not configured\n");
    process.exit(1);
  }
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      continue;
    }
    const response = await handleMcpMessage(message, runtime);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

main().catch(() => {
  process.stderr.write("mcp stdio failed to start\n");
  process.exit(1);
});
