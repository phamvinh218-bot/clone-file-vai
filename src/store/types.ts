export type UserRow = { id: string; email: string; passwordHash: string; createdAt: string };

export type AssetRow = {
  id: string;
  jobId: string;
  role: "mockup" | "vector" | "artifact";
  kind: string | null;
  filename: string;
  mediaType: string;
  byteSize: number;
  createdAt: string;
};

export type GrantRow = {
  id: string;
  jobId: string;
  tokenHash: string;
  artifactKind: string;
  maxBytes: number;
  expiresAt: string;
  usedAt: string | null;
};

export type JobRow = {
  id: string;
  ownerId: string;
  status: string;
  rev: number;
  doc: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export interface Store {
  readonly driverName: "sqlite" | "memory-mock";
  readonly storageLabel: string;
  close(): Promise<void>;
  createUser(user: UserRow): Promise<void>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  getUser(id: string): Promise<UserRow | null>;
  countUsers(): Promise<number>;
  insertJob(row: JobRow): Promise<void>;
  getJob(id: string): Promise<JobRow | null>;
  listJobsByOwner(ownerId: string): Promise<JobRow[]>;
  listJobsByStatus(statuses: string[]): Promise<JobRow[]>;
  compareAndSwapJob(
    id: string,
    expectedRev: number,
    next: { status: string; doc: Record<string, unknown>; updatedAt: string },
  ): Promise<JobRow | null>;
  insertAsset(meta: AssetRow, bytes: Buffer): Promise<void>;
  getAsset(id: string): Promise<(AssetRow & { bytes: Buffer }) | null>;
  listAssets(jobId: string): Promise<AssetRow[]>;
  replaceArtifact(meta: AssetRow, bytes: Buffer): Promise<void>;
  putIdempotency(ownerId: string, scope: string, key: string, jobId: string, createdAt: string): Promise<"created" | "exists">;
  getIdempotency(ownerId: string, scope: string, key: string): Promise<{ jobId: string } | null>;
  insertGrant(grant: GrantRow): Promise<void>;
  getGrantByHash(tokenHash: string): Promise<GrantRow | null>;
  consumeGrant(tokenHash: string, nowIso: string): Promise<GrantRow | null>;
}
