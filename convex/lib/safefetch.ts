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

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if it isn't
 * one. Necessary because the address that reaches us has already been
 * through the WHATWG URL parser, which *canonicalizes* — so the textual
 * form we were given is not the form we get. `[::ffff:127.0.0.1]` arrives
 * as `::ffff:7f00:1`, and prefix-matching on the original spelling misses
 * it entirely. Working on the numbers instead makes the spelling
 * irrelevant.
 */
function expandIpv6(raw: string): number[] | null {
  // Zone ids (`%25eth0` once percent-encoded) name an interface, not an
  // address; they can't change which address this is.
  const addr = raw.split("%")[0];
  if (!addr.includes(":")) return null;

  const [headText, tailText, ...rest] = addr.split("::");
  if (rest.length > 0) return null; // at most one "::" run

  const parseGroups = (text: string): number[] | null => {
    if (!text) return [];
    const out: number[] = [];
    const parts = text.split(":");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // A trailing dotted quad (`::ffff:127.0.0.1`) occupies two groups.
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        const v4 = ipv4ToInt(part);
        if (v4 === null || !part.includes(".")) return null;
        out.push(v4 >>> 16, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  const head = parseGroups(headText);
  const tail = tailText === undefined ? [] : parseGroups(tailText);
  if (head === null || tail === null) return null;

  if (tailText === undefined) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

/** The embedded IPv4 of an IPv4-mapped (::ffff:0:0/96) address, if any. */
function mappedIpv4(groups: number[]): number | null {
  const mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff;
  if (!mapped) return null;
  return (((groups[6] << 16) >>> 0) + groups[7]) >>> 0;
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
    const groups = expandIpv6(host.replace(/^\[|\]$/g, ""));
    // Unparseable as IPv6 — not something we can vouch for.
    if (!groups) return true;
    // An IPv4-mapped address is an IPv4 destination wearing v6 spelling,
    // and must be judged by the same ranges.
    const mapped = mappedIpv4(groups);
    if (mapped !== null) return isForbiddenIpv4(mapped);
    if (groups.every((g) => g === 0)) return true; // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
      return true; // ::1 loopback
    }
    if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    return false;
  }

  const ip = ipv4ToInt(host);
  if (ip === null) return false; // a hostname — DNS residual risk, allowed
  return isForbiddenIpv4(ip);
}

/** True for IPv4 addresses in private, loopback or otherwise reserved space. */
function isForbiddenIpv4(ip: number): boolean {
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
