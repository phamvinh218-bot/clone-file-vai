import type { AssetRow, GrantRow, JobRow, Store, UserRow } from "@/store/types";

/**
 * Explicit test double. It is not durable and the server refuses it unless
 * STORE_DRIVER=memory-mock and MEMORY_STORE_ACK=test-only, outside production.
 */
export function createMemoryStore(): Store {
  const users = new Map<string, UserRow>();
  const jobs = new Map<string, JobRow>();
  const assets = new Map<string, AssetRow & { bytes: Buffer }>();
  const idem = new Map<string, { jobId: string }>();
  const grants = new Map<string, GrantRow>();
  const idemKey = (ownerId: string, scope: string, key: string) => `${ownerId}\0${scope}\0${key}`;

  return {
    driverName: "memory-mock",
    storageLabel: "TEST ONLY in-memory mock. Not durable. Not used by local dev or a real bot run.",
    async close() {
      users.clear();
      jobs.clear();
      assets.clear();
      idem.clear();
      grants.clear();
    },
    async createUser(user) {
      if ([...users.values()].some((row) => row.email === user.email)) {
        throw new Error("email exists");
      }
      users.set(user.id, user);
    },
    async replacePasswordHash(email, passwordHash) {
      const user = [...users.values()].find((row) => row.email === email);
      if (!user) return false;
      users.set(user.id, { ...user, passwordHash });
      return true;
    },
    async findUserByEmail(email) {
      return [...users.values()].find((row) => row.email === email) ?? null;
    },
    async getUser(id) {
      return users.get(id) ?? null;
    },
    async countUsers() {
      return users.size;
    },
    async insertJob(row) {
      jobs.set(row.id, structuredClone(row));
    },
    async getJob(id) {
      const row = jobs.get(id);
      return row ? structuredClone(row) : null;
    },
    async listJobsByOwner(ownerId) {
      return [...jobs.values()]
        .filter((row) => row.ownerId === ownerId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((row) => structuredClone(row));
    },
    async listJobsByStatus(statuses) {
      const allowed = new Set(statuses);
      return [...jobs.values()].filter((row) => allowed.has(row.status)).map((row) => structuredClone(row));
    },
    async compareAndSwapJob(id, expectedRev, next) {
      const row = jobs.get(id);
      if (!row || row.rev !== expectedRev) return null;
      const updated: JobRow = { ...row, status: next.status, doc: structuredClone(next.doc), rev: row.rev + 1, updatedAt: next.updatedAt };
      jobs.set(id, updated);
      return structuredClone(updated);
    },
    async insertAsset(meta, bytes) {
      assets.set(meta.id, { ...meta, bytes: Buffer.from(bytes) });
    },
    async getAsset(id) {
      const row = assets.get(id);
      return row ? { ...row, bytes: Buffer.from(row.bytes) } : null;
    },
    async listAssets(jobId) {
      return [...assets.values()]
        .filter((row) => row.jobId === jobId)
        .map((row) => ({
        id: row.id,
        jobId: row.jobId,
        role: row.role,
        kind: row.kind,
        filename: row.filename,
        mediaType: row.mediaType,
        byteSize: row.byteSize,
        createdAt: row.createdAt,
      }));
    },
    async replaceArtifact(meta, bytes) {
      for (const [id, row] of assets) {
        if (row.jobId === meta.jobId && row.role === "artifact" && row.kind === meta.kind) assets.delete(id);
      }
      assets.set(meta.id, { ...meta, bytes: Buffer.from(bytes) });
    },
    async putIdempotency(ownerId, scope, key, jobId) {
      const id = idemKey(ownerId, scope, key);
      if (idem.has(id)) return "exists";
      idem.set(id, { jobId });
      return "created";
    },
    async getIdempotency(ownerId, scope, key) {
      return idem.get(idemKey(ownerId, scope, key)) ?? null;
    },
    async insertGrant(grant) {
      grants.set(grant.tokenHash, { ...grant });
    },
    async getGrantByHash(tokenHash) {
      const grant = grants.get(tokenHash);
      return grant ? { ...grant } : null;
    },
    async consumeGrant(tokenHash, nowIso) {
      const grant = grants.get(tokenHash);
      if (!grant || grant.usedAt || grant.expiresAt <= nowIso) return null;
      grant.usedAt = nowIso;
      return { ...grant };
    },
  };
}
