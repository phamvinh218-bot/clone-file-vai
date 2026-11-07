function isPrivateIp(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const v6 = host.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd");
}

/** True only for an https origin a cloud bot could plausibly reach. Localhost and private IPs are false. */
export function isPublicHttpsOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "metadata.google.internal" || host === "metadata.internal") return false;
  if (isPrivateIp(host)) return false;
  return true;
}
