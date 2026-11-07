import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssetRow, GrantRow, JobRow, Store } from "@/store/types";

const ID_RE = /^[0-9a-f-]{36}$/i;

function assertId(value: string) {
  if (!ID_RE.test(value)) throw new Error("Unsafe storage id");
}

export function openSqliteStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const blobDir = path.join(dataDir, "blobs");
  mkdirSync(blobDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "app.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      created_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id text PRIMARY KEY,
      owner_id text NOT NULL,
      status text NOT NULL,
      rev integer NOT NULL,
      doc text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
    CREATE TABLE IF NOT EXISTS assets (
      id text PRIMARY KEY,
      job_id text NOT NULL,
      role text NOT NULL,
      kind text,
      filename text NOT NULL,
      media_type text NOT NULL,
      byte_size integer NOT NULL,
      created_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      owner_id text NOT NULL,
      scope text NOT NULL,
      key text NOT NULL,
      job_id text NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY (owner_id, scope, key)
    );
    CREATE TABLE IF NOT EXISTS upload_grants (
      id text PRIMARY KEY,
      job_id text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      artifact_kind text NOT NULL,
      max_bytes integer NOT NULL,
      expires_at text NOT NULL,
      used_at text
    );
  `);

  const blobPath = (jobId: string, assetId: string) => {
    assertId(jobId);
    assertId(assetId);
    return path.join(blobDir, jobId, assetId);
  };
  const writeBlob = (jobId: string, assetId: string, bytes: Buffer) => {
    const dir = path.join(blobDir, jobId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(blobPath(jobId, assetId), bytes, { mode: 0o600 });
  };
  const readJob = (row: Record<string, unknown> | undefined): JobRow | null => {
    if (!row) return null;
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      status: String(row.status),
      rev: Number(row.rev),
      doc: JSON.parse(String(row.doc)) as Record<string, unknown>,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  };
  const readAsset = (row: Record<string, unknown>): AssetRow => ({
    id: String(row.id),
    jobId: String(row.job_id),
    role: row.role as AssetRow["role"],
    kind: row.kind == null ? null : String(row.kind),
    filename: String(row.filename),
    mediaType: String(row.media_type),
    byteSize: Number(row.byte_size),
    createdAt: String(row.created_at),
  });

  return {
    driverName: "sqlite",
    storageLabel: "Durable local SQLite database plus a private blob directory outside the web root.",
    async close() {
      db.close();
    },
    async createUser(user) {
      db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
        user.id,
        user.email,
        user.passwordHash,
        user.createdAt,
      );
    },
    async replacePasswordHash(email, passwordHash) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const info = db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(passwordHash, email);
        db.exec("COMMIT");
        return Number(info.changes) === 1;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async findUserByEmail(email) {
      const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Record<string, unknown> | undefined;
      if (!row) return null;
      return { id: String(row.id), email: String(row.email), passwordHash: String(row.password_hash), createdAt: String(row.created_at) };
    },
    async getUser(id) {
      const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return { id: String(row.id), email: String(row.email), passwordHash: String(row.password_hash), createdAt: String(row.created_at) };
    },
    async countUsers() {
      const row = db.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
      return Number(row.n);
    },
    async insertJob(row) {
      db.prepare("INSERT INTO jobs (id, owner_id, status, rev, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        row.id,
        row.ownerId,
        row.status,
        row.rev,
        JSON.stringify(row.doc),
        row.createdAt,
        row.updatedAt,
      );
    },
    async getJob(id) {
      return readJob(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined);
    },
    async listJobsByOwner(ownerId) {
      const rows = db.prepare("SELECT * FROM jobs WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId) as Record<string, unknown>[];
      return rows.map((row) => readJob(row)!);
    },
    async listJobsByStatus(statuses) {
      if (statuses.length === 0) return [];
      const marks = statuses.map(() => "?").join(", ");
      const rows = db.prepare(`SELECT * FROM jobs WHERE status IN (${marks})`).all(...statuses) as Record<string, unknown>[];
      return rows.map((row) => readJob(row)!);
    },
    async compareAndSwapJob(id, expectedRev, next) {
      const info = db
        .prepare("UPDATE jobs SET status = ?, doc = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?")
        .run(next.status, JSON.stringify(next.doc), next.updatedAt, id, expectedRev);
      if (Number(info.changes) !== 1) return null;
      return readJob(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown>);
    },
    async insertAsset(meta, bytes) {
      writeBlob(meta.jobId, meta.id, bytes);
      db.prepare(
        "INSERT INTO assets (id, job_id, role, kind, filename, media_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(meta.id, meta.jobId, meta.role, meta.kind, meta.filename, meta.mediaType, meta.byteSize, meta.createdAt);
    },
    async getAsset(id) {
      const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      const meta = readAsset(row);
      const bytes = readFileSync(blobPath(meta.jobId, meta.id));
      return { ...meta, bytes };
    },
    async listAssets(jobId) {
      const rows = db.prepare("SELECT * FROM assets WHERE job_id = ? ORDER BY created_at").all(jobId) as Record<string, unknown>[];
      return rows.map(readAsset);
    },
    async replaceArtifact(meta, bytes) {
      const previous = db
        .prepare("SELECT id, job_id FROM assets WHERE job_id = ? AND role = 'artifact' AND kind = ?")
        .all(meta.jobId, meta.kind) as Array<{ id: string; job_id: string }>;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of previous) {
          db.prepare("DELETE FROM assets WHERE id = ?").run(row.id);
          rmSync(blobPath(String(row.job_id), String(row.id)), { force: true });
        }
        writeBlob(meta.jobId, meta.id, bytes);
        db.prepare(
          "INSERT INTO assets (id, job_id, role, kind, filename, media_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(meta.id, meta.jobId, meta.role, meta.kind, meta.filename, meta.mediaType, meta.byteSize, meta.createdAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async putIdempotency(ownerId, scope, key, jobId, createdAt) {
      const info = db
        .prepare("INSERT INTO idempotency (owner_id, scope, key, job_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(ownerId, scope, key, jobId, createdAt);
      return Number(info.changes) === 1 ? "created" : "exists";
    },
    async getIdempotency(ownerId, scope, key) {
      const row = db.prepare("SELECT job_id FROM idempotency WHERE owner_id = ? AND scope = ? AND key = ?").get(ownerId, scope, key) as
        | { job_id: string }
        | undefined;
      return row ? { jobId: row.job_id } : null;
    },
    async insertGrant(grant) {
      db.prepare(
        "INSERT INTO upload_grants (id, job_id, token_hash, artifact_kind, max_bytes, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(grant.id, grant.jobId, grant.tokenHash, grant.artifactKind, grant.maxBytes, grant.expiresAt, grant.usedAt);
    },
    async getGrantByHash(tokenHash) {
      const row = db.prepare("SELECT * FROM upload_grants WHERE token_hash = ?").get(tokenHash) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: String(row.id),
        jobId: String(row.job_id),
        tokenHash,
        artifactKind: String(row.artifact_kind),
        maxBytes: Number(row.max_bytes),
        expiresAt: String(row.expires_at),
        usedAt: row.used_at == null ? null : String(row.used_at),
      } satisfies GrantRow;
    },
    async consumeGrant(tokenHash, nowIso) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT * FROM upload_grants WHERE token_hash = ?").get(tokenHash) as Record<string, unknown> | undefined;
        if (!row || row.used_at || String(row.expires_at) <= nowIso) {
          db.exec("COMMIT");
          return null;
        }
        const info = db.prepare("UPDATE upload_grants SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").run(nowIso, tokenHash);
        db.exec("COMMIT");
        if (Number(info.changes) !== 1) return null;
        return {
          id: String(row.id),
          jobId: String(row.job_id),
          tokenHash,
          artifactKind: String(row.artifact_kind),
          maxBytes: Number(row.max_bytes),
          expiresAt: String(row.expires_at),
          usedAt: nowIso,
        } satisfies GrantRow;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
