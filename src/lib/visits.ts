/**
 * Per-device "last visited" tracking for the Library — a localStorage map of
 * pageId → timestamp, like Notion's per-user visit times. Deliberately not
 * workspace data: which pages *you* opened on *this* device is a vantage
 * point, not content (same reasoning as the selected view tab).
 */

const KEY = "vellum:visits";
/** Keep the map bounded; oldest visits fall off. */
const MAX_ENTRIES = 300;

let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(map: Record<string, number>) {
  cache = map;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function recordVisit(pageId: string, now: number = Date.now()) {
  const map = { ...load(), [pageId]: now };
  const entries = Object.entries(map);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1] - a[1]);
    save(Object.fromEntries(entries.slice(0, MAX_ENTRIES)));
  } else {
    save(map);
  }
}

/** pageId → last-visited timestamp (ms). Read-only snapshot. */
export function visitTimes(): Record<string, number> {
  return load();
}

/**
 * A page created offline swaps its temp id for the real Convex id on sync —
 * rewrite the visit key too, or its history dies at that moment. Same event
 * the nav state and tabs listen to (see state.tsx).
 */
if (typeof window !== "undefined") {
  window.addEventListener("vellum:id-remapped", (e: Event) => {
    const { from, to } = (e as CustomEvent<{ from: string; to: string }>).detail;
    const map = load();
    if (map[from] !== undefined) {
      const { [from]: ts, ...rest } = map;
      save({ ...rest, [to]: ts });
    }
  });
}

/**
 * Notion-style mixed relative/absolute times: recent gets "Just now" /
 * "5m ago" / "3h ago" / "2d ago" / "3w ago", older gets "Feb 22, 2023".
 */
export function formatVisitTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  if (diff < 35 * 86_400_000) {
    return `${Math.floor(diff / (7 * 86_400_000))}w ago`;
  }
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
