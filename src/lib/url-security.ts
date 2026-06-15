import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

function isPrivateAddress(address: string) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

export async function assertSafePublicUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not supported.");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("Private network URLs are not allowed.");
  }

  const directIpVersion = net.isIP(hostname);
  if (directIpVersion && isPrivateAddress(hostname)) {
    throw new Error("Private network URLs are not allowed.");
  }

  if (!directIpVersion) {
    let addresses: { address: string; family: number }[];
    try {
      addresses = await dns.lookup(hostname, { all: true });
    } catch {
      throw new Error("The URL hostname could not be resolved.");
    }

    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("Private network URLs are not allowed.");
    }
  }

  return url;
}
