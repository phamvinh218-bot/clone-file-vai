# clone-file-vai

Internal tool for Vinh's workshop. Staff upload a fabric mockup and a laser vector. The app stores the files, reads real vector bounds, and applies the versioned 10 mm applique layout. A Grok Bot routine is the only worker that is meant to reconstruct fabric appearance and return the print PNG, actual-size PDF, and a separate proof.

This repository does not call a model API, does not draw fabric, and does not mark a job complete when a webhook returns.

## Where this was verified

The tests, production build, and HTTP smoke in this change ran on the cloud agent's Linux workspace (`/workspace`), branch `cursor/applique-local-poc-3fbd`. They did **not** run on `C:\Job\DLLT - learning\clone-file-vai`, and that Windows folder was not edited.

A green test run is a local contract test with SQLite or the labeled in-memory double. It is not a Grok Bot round trip. No bot was called. No tunnel was opened. No Vercel project was created.

## Local storage

Default `STORE_DRIVER` is `sqlite`.

- Database: `$DATA_DIR/app.sqlite` (default `./data/app.sqlite`)
- Private blobs: `$DATA_DIR/blobs/` (not under `public/`)
- Node's built-in `node:sqlite` is used. On Node 22 it still prints an experimental warning.

`STORE_DRIVER=postgres` is reserved and fails closed. No cloud database is provisioned. `STORE_DRIVER=memory-mock` boots only with `MEMORY_STORE_ACK=test-only` and `NODE_ENV` other than `production`. Tests that use it are labeled in the store's `storageLabel`.

The same `Store` interface is what a future durable hosted adapter would implement. Local boot does not need that adapter or any cloud credential.

SQLite on a laptop is durable across restarts of `npm run dev`. It is not a substitute for a hosted database if this app is later put on ephemeral serverless disk. That deployment is intentionally not done here.

The browser policy allows inline scripts and inline styles because the Next.js app router boots the page that way. Other script hosts, frames, and plugins stay blocked. Uploaded SVG is downloaded as an attachment, not rendered as a page.

`Referrer-Policy` is `strict-origin-when-cross-origin`. The Fetch standard turns `no-referrer` into the literal header `Origin: null` on a same-origin form POST, and login was rejecting that as an invalid URL. An opaque `null` origin is still refused; it is not treated as same-origin. After pulling this fix, restart `npm run dev` and open `/login` again. Do not resubmit the `/api/session` page.

## Layout rule

Version: `applique-layout/1` in `src/spec/applique-layout.v1.json`.

- Only applique pieces. Text and tiny decoration are not pieces.
- One distinct pattern: one continuous sheet covering every piece.
- Two or more distinct patterns: one panel per piece, in file order, including a pattern that repeats.
- Bounds come from transformed path geometry, including holes. The artboard or viewBox is not the cut size.
- A non-PDF `.ai` file is rejected. Save a PDF or SVG by hand.
- Nominal 1:1 needs a physical unit in the file (mm, cm, in, or pt) and the staff checkbox. Otherwise the job stays a preview.
- Allowance is 10 mm outside every side (20 mm added to width and height). At 300 PPI the margin is `ceil(10 / 25.4 * 300) = 119` px, and bbox extents are ceiled the same way. The historical NURSE sample used 20 mm (237 px). New jobs do not.

## Grok Bot webhook

Official pages read for this implementation:

- https://cursor.com/help/grok-bot/routines
- https://docs.x.ai/grok-bot/skills-routines-and-automations (page last updated 29 October 2026)

Documented behavior that this app implements:

- `POST` the routine URL.
- `Authorization: Bearer <key>` using the key shown on the routine. The key is trimmed and refused if it contains a newline.
- Optional JSON body. The bot receives that body with the routine instruction.
- HTTP **200** means the run was accepted and started. The job stays `dispatched`, not `completed`.
- Any other status, including 201, means a run did not start. The job becomes `dispatch_failed`.

Not documented, so not invented:

- No provider JSON schema. The body is this app's contract `clone-file-vai.job-dispatch.v1`: `contract`, `event`, `jobId`, `specVersion`, `mcpUrl`.
- No provider response-body schema. The body is discarded. A `"finished": true` flag in it does not complete the job.
- Redirects are not followed, so the bearer key is not sent to another host.

Dispatch is refused unless `APP_ORIGIN` is public `https`. `http://127.0.0.1` does not count. The webhook URL and key stay in server environment variables and are not returned to the browser.

## MCP

Path: `POST /api/mcp`

Auth: `Authorization: Bearer <BOT_WORKER_TOKEN>`. A staff session cookie is not accepted. If `BOT_WORKER_TOKEN` is missing, the route returns 503 `not_configured` rather than running open.

Transport, from the MCP Streamable HTTP spec (2025-06-18):

- `Accept` must list both `application/json` and `text/event-stream`.
- One JSON-RPC message per POST. Responses are a single JSON object. This server does not open an SSE stream.
- `GET` and `DELETE` return 405.
- Stateless: no `Mcp-Session-Id`.
- Accepted protocol versions: `2025-06-18` and `2025-03-26`.

Tools (`src/spec/mcp-tools.v1.json`): `list_jobs`, `get_job`, `claim_job`, `create_source_download`, `create_artifact_upload`, `complete_job`, `fail_job`.

Source files are returned inline over the authenticated MCP call when they fit. A signed URL is added only when `APP_ORIGIN` is public https. Artifact upload is a one-time grant: `POST` the bytes with `Authorization: Bearer <grantToken>`. JSON bodies and `url` parameters are rejected. The server does not fetch a URL.

Grok Bot docs (https://docs.x.ai/grok-bot/computer-and-apps) say a bot can add an MCP server by public URL or by a command that runs **on the bot's computer**, then complete authentication. They do not publish the connector form's header name. The Grok API `authorization` parameter is documented to be sent as `Authorization: Bearer`, but that is a different API and this app does not call it. Whether the Bot connector form has a bearer field is **unverified**. The server still requires the bearer token.

`npm run mcp:stdio` is a real stdio MCP process against the local SQLite directory. It is not a mock bot. Whoever can run that process can use the tools, so do not expose its stdin to the network. The bot's cloud computer does not have this machine's `DATA_DIR`, so the command does not connect the cloud bot to Windows or to this workspace.

## Local integration choices

A cloud bot cannot call `127.0.0.1` on the workshop PC. This app does not open a tunnel and does not publish uploads.

1. **Manual handoff** (implemented). The staff action "Bàn giao tay" writes status `manual_handoff` and shows a JSON packet with geometry and file names. It does not call the bot, does not upload the mockup, and is not a completed job. Download the source files from the job page and attach them yourself if you choose to paste the packet into chat.
2. **Public HTTPS later.** Needs a separate decision and consent. Not done. After that, set `APP_ORIGIN`, the webhook URL and key, and the worker token. Then the bot can receive the webhook and call `/api/mcp`.
3. **A tunnel you operate yourself.** Grok's connector docs mention ngrok or Cloudflare for a *Grok* custom MCP, not as something this app should start. This app will not start one. A tunnel publishes the port. Auth would still be required, but that choice is yours.
4. **Stdio on the bot computer.** Only useful if that computer has the job database. It does not.

## Environment variable names

Set these in `.env.local`. Do not commit values.

| Name | Required to boot the UI | Purpose |
| --- | --- | --- |
| `DATA_DIR` | No (default `./data`) | SQLite file and private blobs |
| `STORE_DRIVER` | No (default `sqlite`) | `sqlite`, or reserved `postgres`, or test-only `memory-mock` |
| `SESSION_SECRET` | Yes, to log in | Staff session HMAC, 32+ characters |
| `ASSET_SIGNING_SECRET` | Yes, before signed URLs | Download HMAC, 32+ characters |
| `BOT_WORKER_TOKEN` | Yes, before MCP accepts calls | Worker bearer, separate from staff |
| `APP_ORIGIN` | Yes, before a real dispatch | Public https later. Localhost blocks dispatch |
| `GROK_BOT_WEBHOOK_URL` | Only to dispatch | Routine POST URL, server-only |
| `GROK_BOT_WEBHOOK_KEY` | Only to dispatch | Routine bearer key, server-only |
| `STAFF_BOOTSTRAP_EMAIL` | For the first user | Used only when the user table is empty |
| `STAFF_BOOTSTRAP_PASSWORD` | With the email | At least 12 characters |
| `JOB_LEASE_SECONDS` | No (default 900) | Worker lease |
| `MEMORY_STORE_ACK` | Tests only | Must be `test-only` |
| `GROK_BOT_WEBHOOK_ALLOW_INSECURE` | Tests only | `test` allows http webhook targets outside production |

`GET /api/setup` reports these names and whether each gate passes. It does not return secret values.

## Job and artifact shape

Statuses: `needs_pattern`, `ready`, `dispatch_pending`, `dispatched`, `dispatch_failed`, `leased`, `manual_handoff`, `completed`, `failed`.

`dispatched` means the webhook returned 200. `completed` happens only when `complete_job` runs while the lease is active and `print_png`, `print_pdf`, and `proof_png` are already stored. `fail_job` after completion is rejected. `complete_job` after failure is rejected. Repeating the same completion key returns the completed job and does not create a second result.

Staff routes use the `cfv_session` cookie. One staff user cannot read another's job (404). The worker token can see only jobs that are dispatched, leased, completed, or failed.

## Windows setup

Run this yourself in the existing checkout. Do not expect this agent to have touched that directory.

Node.js 22.13 or newer is required.

```powershell
cd "C:\Job\DLLT - learning\clone-file-vai"
git fetch origin
git checkout cursor/applique-local-poc-3fbd
node -v
npm ci
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-Secret {
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes)
  return [Convert]::ToBase64String($bytes)
}
@"
DATA_DIR=./data
STORE_DRIVER=sqlite
SESSION_SECRET=$(New-Secret)
ASSET_SIGNING_SECRET=$(New-Secret)
BOT_WORKER_TOKEN=$(New-Secret)
APP_ORIGIN=http://127.0.0.1:3000
STAFF_BOOTSTRAP_EMAIL=vinh@localhost
STAFF_BOOTSTRAP_PASSWORD=replace-this-local-password
JOB_LEASE_SECONDS=900
"@ | Set-Content -Encoding ascii .env.local
```

Edit `.env.local` and replace `STAFF_BOOTSTRAP_PASSWORD` before the next commands. The generated secrets stay in that ignored file. Do not paste the webhook key or the worker token into chat.

```powershell
npm test
npm run dev
```

Open `http://127.0.0.1:3000`. The setup page lists gates. Log in, create a job, assign one pattern name per piece, then either hand the packet over manually or leave dispatch blocked until a public origin exists.

On Windows, the `0600` file mode used for blobs is not a security boundary. Keep `data\` out of shared folders. The app never serves that directory as static files.

## What to do before one real bot job

1. Run the Windows steps above and confirm a job's geometry locally.
2. Decide the transport. Localhost dispatch will keep returning `origin_not_bot_reachable`.
3. When a public https origin exists, ask this bot in chat to add a webhook trigger to a routine, and paste `src/spec/grok-bot-routine-instruction.v1.txt` as the instruction. Copy the routine URL and key into `GROK_BOT_WEBHOOK_URL` and `GROK_BOT_WEBHOOK_KEY` on the server. Do not put them in the repo or in chat.
4. Add the MCP server by its public `https://<origin>/api/mcp` URL and complete authentication with `BOT_WORKER_TOKEN`. If the connector cannot send a bearer token, stop and say so. Do not switch this app to an undocumented endpoint.
5. Confirm `GET /api/setup` shows the webhook and worker gates ready, then dispatch one safe job. Watch the bot chat. The UI stays on "bot đã được gọi" until the bot calls `complete_job` or `fail_job`.
6. Do not deploy to Vercel, and do not provision Postgres, Blob, or a tunnel, unless you explicitly ask for that later.

## Scripts

- `npm run dev` — local Next.js server
- `npm test` — geometry, auth, idempotency, webhook contract, MCP contract
- `npm run lint` — `next lint`
- `npm run build` — production build, not a deploy
- `npm run mcp:stdio` — local stdio MCP against `DATA_DIR`
