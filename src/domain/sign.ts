import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function secretsEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function signAsset(secret: string, assetId: string, exp: number): string {
  return createHmac("sha256", secret).update(`${assetId}.${exp}.download`).digest("base64url");
}

export function assetSignatureValid(secret: string, assetId: string, exp: number, sig: string): boolean {
  const expected = signAsset(secret, assetId, exp);
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
