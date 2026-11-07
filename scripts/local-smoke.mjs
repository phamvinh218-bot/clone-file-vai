/**
 * Local HTTP smoke against a server you already started.
 * Prints statuses only. Does not print secrets and does not call Grok.
 */
const base = process.env.BASE_URL ?? "http://127.0.0.1:3456";
const email = process.env.STAFF_BOOTSTRAP_EMAIL;
const password = process.env.STAFF_BOOTSTRAP_PASSWORD;
const worker = process.env.BOT_WORKER_TOKEN;
if (!email || !password || !worker) {
  console.error("Missing STAFF_BOOTSTRAP_EMAIL, STAFF_BOOTSTRAP_PASSWORD, or BOT_WORKER_TOKEN");
  process.exit(1);
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="40mm" viewBox="0 0 80 40"><rect x="5" y="5" width="25" height="20"/><rect x="40" y="6" width="20" height="22"/></svg>`;

function assert(cond, message) {
  if (!cond) {
    console.error("SMOKE FAIL:", message);
    process.exit(1);
  }
}

const setup = await fetch(`${base}/api/setup`);
const setupBody = await setup.json();
assert(setup.status === 200, "setup");
assert(!JSON.stringify(setupBody).includes(worker), "setup leaked the worker token");
assert(!JSON.stringify(setupBody).includes(password), "setup leaked the password");
console.log("setup", setup.status, "gates", setupBody.gates.map((gate) => `${gate.name}:${gate.ok ? "ok" : "missing"}`).join(" "));

const login = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: { origin: base, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ email, password }),
});
assert(login.status === 200, `login ${login.status}`);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert(cookie?.startsWith("cfv_session="), "session cookie");

const form = new FormData();
form.set("title", "Smoke hai mảnh");
form.set("scaleConfirmed", "true");
form.set("mockup", new File([png], "mock.png", { type: "image/png" }));
form.set("vector", new File([Buffer.from(svg)], "cut.svg", { type: "image/svg+xml" }));
const created = await fetch(`${base}/api/jobs`, {
  method: "POST",
  headers: { origin: base, accept: "application/json", cookie },
  body: form,
});
const createdBody = await created.json();
assert(created.status === 201, `create ${created.status} ${createdBody.error ?? ""}`);
assert(createdBody.complete === false, "new job must not be complete");
assert(createdBody.layout === null, "patterns not assigned yet");
console.log("create", created.status, createdBody.status, "pieces", createdBody.pieces.length, "printReady", createdBody.printReady);

const patterns = new URLSearchParams();
for (const piece of createdBody.pieces) patterns.set(`pattern_${piece.id}`, piece.index === 1 ? "ke" : "hoa");
const laid = await fetch(`${base}/api/jobs/${createdBody.id}/patterns`, {
  method: "POST",
  headers: { origin: base, accept: "application/json", cookie, "content-type": "application/x-www-form-urlencoded" },
  body: patterns,
});
const laidBody = await laid.json();
assert(laid.status === 200, `patterns ${laid.status}`);
assert(laidBody.layout.mode === "per_piece", "two patterns should split panels");
assert(laidBody.layout.marginPx === 119, `margin ${laidBody.layout.marginPx}`);
console.log("layout", laidBody.layout.mode, "marginPx", laidBody.layout.marginPx, "panels", laidBody.layout.sheets.length);

const dispatch = await fetch(`${base}/api/jobs/${createdBody.id}/dispatch`, {
  method: "POST",
  headers: { origin: base, accept: "application/json", cookie },
});
const dispatchBody = await dispatch.json();
const blocked = (dispatch.status === 503 && dispatchBody.error === "not_configured") || (dispatch.status === 409 && dispatchBody.error === "origin_not_bot_reachable");
assert(blocked, `dispatch ${dispatch.status} ${dispatchBody.error ?? ""}`);
const after = await fetch(`${base}/api/jobs/${createdBody.id}`, { headers: { accept: "application/json", cookie } });
const afterBody = await after.json();
assert(afterBody.complete === false && afterBody.status !== "dispatched" && afterBody.status !== "completed", afterBody.status);
console.log("dispatch", dispatch.status, dispatchBody.error, "job", afterBody.status);

const handoff = await fetch(`${base}/api/jobs/${createdBody.id}/handoff`, {
  method: "POST",
  headers: { origin: base, accept: "application/json", cookie },
});
const handoffBody = await handoff.json();
assert(handoff.status === 200, `handoff ${handoff.status}`);
assert(handoffBody.status === "manual_handoff", handoffBody.status);
assert(handoffBody.complete === false && handoffBody.failed === false, "handoff is not a bot result");
console.log("handoff", handoffBody.status, "complete", handoffBody.complete);

const mcp = await fetch(`${base}/api/mcp`, {
  method: "POST",
  headers: {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${worker}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-smoke", version: "0" } },
  }),
});
const mcpBody = await mcp.json();
assert(mcp.status === 200 && mcpBody.result.protocolVersion === "2025-06-18", "mcp initialize");
console.log("mcp", mcp.status, mcpBody.result.serverInfo.name, mcpBody.result.protocolVersion);
console.log("SMOKE OK — local contract only, not a Grok Bot round trip");
