/**
 * URL → embeddable iframe source.
 *
 * Notion's `/embed`: paste a normal share link and get a live player rather
 * than a link. BlockNote's built-in `video` block renders a raw <video>
 * element, which cannot play YouTube/Vimeo/Loom URLs — those need the
 * provider's iframe player, which is what this module resolves.
 *
 * Pure and dependency-free so it can be unit-tested (see tests/embeds.test.ts).
 */

export interface EmbedInfo {
  /** False only for the anything-else fallback: an arbitrary URL gets a
   *  tighter iframe sandbox (no allow-same-origin — combined with
   *  allow-scripts it voids the sandbox, and /p/* proxies onto our own
   *  origin). Audit finding, 2026-08-12. */
  known?: boolean;
  /** URL to put in the iframe. */
  src: string;
  /** Human label shown in the block's footer. */
  provider: string;
  /** width / height, used for the placeholder box. */
  aspect: number;
  allowFullscreen: boolean;
}

const YT_ASPECT = 16 / 9;

function parse(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    // Only ever embed http(s) — never javascript:, data:, file: …
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url;
  } catch {
    return null;
  }
}

const host = (url: URL) => url.hostname.replace(/^www\./, "").toLowerCase();

/** YouTube video id from any of its share/watch/short/embed URL shapes. */
function youtubeId(url: URL): string | null {
  const h = host(url);
  if (h === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
  if (h !== "youtube.com" && h !== "m.youtube.com" && h !== "music.youtube.com") {
    return null;
  }
  const v = url.searchParams.get("v");
  if (v) return v;
  const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** Playback offset in seconds, from ?t=90 / ?t=1m30s / ?start=90. */
function startSeconds(url: URL): number | null {
  const raw = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || !m[0]) return null;
  const secs =
    Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return secs || null;
}

export function toEmbed(raw: string): EmbedInfo | null {
  const url = parse(raw);
  if (!url) return null;
  const h = host(url);
  const path = url.pathname;

  // --- YouTube ---
  const yt = youtubeId(url);
  if (yt) {
    const start = startSeconds(url);
    return {
      src: `https://www.youtube.com/embed/${encodeURIComponent(yt)}${start ? `?start=${start}` : ""}`,
      provider: "YouTube",
      aspect: YT_ASPECT,
      allowFullscreen: true,
    };
  }

  // --- Vimeo ---
  if (h === "vimeo.com" || h === "player.vimeo.com") {
    const m = path.match(/(?:\/video)?\/(\d+)/);
    if (m) {
      return {
        src: `https://player.vimeo.com/video/${m[1]}`,
        provider: "Vimeo",
        aspect: YT_ASPECT,
        allowFullscreen: true,
      };
    }
  }

  // --- Loom ---
  if (h === "loom.com" || h === "www.loom.com") {
    const m = path.match(/\/(?:share|embed)\/([0-9a-z]+)/i);
    if (m) {
      return {
        src: `https://www.loom.com/embed/${m[1]}`,
        provider: "Loom",
        aspect: YT_ASPECT,
        allowFullscreen: true,
      };
    }
  }

  // --- Spotify --- (fixed-height player; the aspect keeps it compact)
  if (h === "open.spotify.com") {
    const m = path.match(/\/(track|album|playlist|episode|show|artist)\/([^/?#]+)/);
    if (m) {
      return {
        src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`,
        provider: "Spotify",
        aspect: m[1] === "track" || m[1] === "episode" ? 5 : 1.4,
        allowFullscreen: false,
      };
    }
  }

  // --- Figma ---
  if (h === "figma.com") {
    if (/^\/(file|design|proto|board|slides)\//.test(path)) {
      return {
        src: `https://www.figma.com/embed?embed_host=vellum&url=${encodeURIComponent(url.toString())}`,
        provider: "Figma",
        aspect: 4 / 3,
        allowFullscreen: true,
      };
    }
  }

  // --- CodePen ---
  if (h === "codepen.io") {
    const m = path.match(/^\/([^/]+)\/(?:pen|embed|details|full)\/([^/?#]+)/);
    if (m) {
      return {
        src: `https://codepen.io/${m[1]}/embed/${m[2]}`,
        provider: "CodePen",
        aspect: 4 / 3,
        allowFullscreen: true,
      };
    }
  }

  // --- Google Docs / Sheets / Slides / Drive ---
  if (h === "docs.google.com" || h === "drive.google.com") {
    // Rebuild from the parts rather than trimming the tail — /edit, /view,
    // /edit#gid=0 and bare /d/<id> all have to land on the same /preview.
    const m = path.match(/^\/(document|spreadsheets|presentation|file)\/d\/([^/?#]+)/);
    if (m) {
      return {
        src: `https://${h}/${m[1]}/d/${m[2]}/preview`,
        provider: "Google Drive",
        aspect: 4 / 3,
        allowFullscreen: true,
      };
    }
  }

  // --- Google Maps ---
  if (h === "google.com" || h === "maps.google.com" || h === "maps.app.goo.gl") {
    if (path.startsWith("/maps/embed")) {
      return {
        src: url.toString(),
        provider: "Google Maps",
        aspect: 4 / 3,
        allowFullscreen: true,
      };
    }
    if (path.startsWith("/maps") || h === "maps.app.goo.gl") {
      // @lat,lng,zoom is the most reliable locator; fall back to the place name.
      const at = path.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
      const place = path.match(/\/maps\/place\/([^/@]+)/);
      const q = at
        ? `${at[1]},${at[2]}`
        : place
          ? decodeURIComponent(place[1]).replace(/\+/g, " ")
          : url.searchParams.get("q");
      if (q) {
        return {
          src: `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`,
          provider: "Google Maps",
          aspect: 4 / 3,
          allowFullscreen: true,
        };
      }
    }
  }

  // --- Anything else: embed as-is. Sites that refuse framing (via
  // X-Frame-Options / CSP) render blank, which is why the block always keeps
  // a visible "open original" link.
  return {
    src: url.toString(),
    provider: h,
    aspect: 4 / 3,
    allowFullscreen: true,
    known: false,
  };
}

/** True when the string looks embeddable — drives the button's disabled state. */
export function isEmbeddable(raw: string): boolean {
  return toEmbed(raw) !== null;
}
