/**
 * SSRF-guarded fetch for the two server-side fetchers (linkPreview's
 * fetchMeta and the agent's fetchUrlText) — audit finding 6, 2026-08-12.
 *
 * Guards: http(s) only; IP-literal hosts in private/reserved ranges are
 * refused; redirects are followed MANUALLY so every hop is re-validated
 * (redirect:"follow" would happily land on 169.254.169.254).
 *
 * Residual risk, documented: a public hostname can still DNS-resolve to
 * a private address (rebinding, *.nip.io) — the Convex runtime offers no
 * DNS API to check. The blast radius is Convex's network, not ours, and
 * their platform is the second line of defense there.
 */

const MAX_REDIRECT_HOPS = 5;

function ipv4ToInt(host: string): number | null {
  // Dotted quad…
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const parts = m.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }
  // …or the single-integer form (http://2130706433/ is 127.0.0.1).
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    return Number.isSafeInteger(n) && n <= 0xffffffff ? n : null;
  }
  return null;
}

function inRange(ip: number, base: number, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/** True for hosts that must never be fetched server-side. */
export function isForbiddenHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // Hex/octal-looking hosts are refused outright rather than parsed.
  if (/^0x/i.test(host)) return true;

  // Bracketed IPv6 literals.
  if (host.startsWith("[") || host.includes(":")) {
    const v6 = host.replace(/^\[|\]$/g, "");
    if (v6 === "::" || v6 === "::1") return true;
    if (/^fe[89ab]/i.test(v6)) return true; // link-local fe80::/10
    if (/^f[cd]/i.test(v6)) return true; // unique-local fc00::/7
    if (v6.startsWith("::ffff:")) {
      // IPv4-mapped — judge the embedded IPv4.
      return isForbiddenHost(v6.slice("::ffff:".length));
    }
    return false;
  }

  const ip = ipv4ToInt(host);
  if (ip === null) return false; // a hostname — DNS residual risk, allowed
  return (
    inRange(ip, 0x00000000, 8) || // 0.0.0.0/8
    inRange(ip, 0x0a000000, 8) || // 10/8
    inRange(ip, 0x64400000, 10) || // 100.64/10 (CGNAT)
    inRange(ip, 0x7f000000, 8) || // 127/8
    inRange(ip, 0xa9fe0000, 16) || // 169.254/16 (cloud metadata)
    inRange(ip, 0xac100000, 12) || // 172.16/12
    inRange(ip, 0xc0a80000, 16) || // 192.168/16
    inRange(ip, 0xc0000200, 24) || // 192.0.2/24 (TEST-NET-1)
    inRange(ip, 0xe0000000, 4) || // 224/4 multicast
    inRange(ip, 0xf0000000, 4) // 240/4 reserved + broadcast
  );
}

/** Null when the URL may not be fetched; the parsed URL otherwise. */
function validate(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isForbiddenHost(url.hostname)) return null;
  return url;
}

/**
 * fetch() with per-hop SSRF validation. Returns null (rather than
 * throwing) when the URL or any redirect target is forbidden — callers
 * already treat null/!ok as "not available".
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  let url = validate(rawUrl);
  for (let hop = 0; url && hop <= MAX_REDIRECT_HOPS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.href, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return res;
        url = validate(new URL(location, url).href);
        continue; // re-validated — loop to the next hop
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
  return null; // invalid URL, forbidden target, or too many hops
}
