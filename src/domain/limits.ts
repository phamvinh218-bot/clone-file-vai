export const LIMITS = {
  mockupBytes: 8 * 1024 * 1024,
  vectorBytes: 8 * 1024 * 1024,
  artifactBytes: 32 * 1024 * 1024,
  inlineBytes: 8 * 1024 * 1024,
  titleChars: 120,
  patternChars: 40,
  passwordMin: 12,
  secretMin: 32,
  leaseSecondsDefault: 900,
  maxLeaseAttempts: 5,
  uploadGrantSeconds: 10 * 60,
  signedUrlSeconds: 10 * 60,
  dispatchLockMs: 60_000,
} as const;

export const ARTIFACT_KINDS = ["print_png", "print_pdf", "proof_png"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}
