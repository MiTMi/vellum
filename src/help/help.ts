/**
 * The Help Center's entire runtime — the same "as little JavaScript as the
 * page can get away with" rule the landing page follows.
 *
 * Four jobs:
 *   1. show one guide at a time, chosen by the URL hash (so every guide is
 *      linkable and the back button works);
 *   2. filter the guide index as you type;
 *   3. build each guide's prev/next footer from the index order, so adding a
 *      guide to the markup never means hand-editing its neighbours;
 *   4. the two bits of landing chrome: the nav's scroll border and the
 *      footer year.
 */

// Same bundling rule as the landing page: fonts come from @fontsource so the
// PWA precache picks the woff2 files up, never from a CDN <link>.
import "@blocknote/core/fonts/inter.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "../landing/landing.css";
import "./help.css";
import { registerSW } from "../pwa/register";

/** The flag Auth.tsx writes once Convex confirms the owner's identity. */
const SESSION_FLAG = "vellum:hasSession";

function hasLocalSession(): boolean {
  try {
    return localStorage.getItem(SESSION_FLAG) === "1";
  } catch {
    return false;
  }
}

if (hasLocalSession()) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-cta]")) {
    el.textContent = "Open Vellum";
  }
}

const nav = document.querySelector<HTMLElement>(".nav");
if (nav) {
  const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

const year = document.querySelector<HTMLElement>("[data-year]");
if (year) year.textContent = String(new Date().getFullYear());

/* ------------------------------------------------------------ routing */

const guides = [...document.querySelectorAll<HTMLElement>(".guide")];
const links = [...document.querySelectorAll<HTMLAnchorElement>(".help-index a")];
const titleOf = (id: string) =>
  links.find((l) => l.hash === `#${id}`)?.textContent?.trim() ?? id;

/** Prev/next, derived from the order of the index rather than hand-written. */
for (const [i, guide] of guides.entries()) {
  const prev = guides[i - 1];
  const next = guides[i + 1];
  if (!prev && !next) continue;
  const footer = document.createElement("nav");
  footer.className = "guide-nav";
  footer.setAttribute("aria-label", "More guides");
  if (prev) {
    footer.insertAdjacentHTML(
      "beforeend",
      `<a class="prev" href="#${prev.id}"><span class="guide-nav-label">Previous</span>${titleOf(prev.id)}</a>`,
    );
  }
  if (next) {
    footer.insertAdjacentHTML(
      "beforeend",
      `<a class="next" href="#${next.id}"><span class="guide-nav-label">Next</span>${titleOf(next.id)}</a>`,
    );
  }
  guide.append(footer);
}

function show(id: string, scroll: boolean): void {
  const target = guides.find((g) => g.id === id) ?? guides[0];
  for (const g of guides) g.classList.toggle("is-open", g === target);
  for (const l of links) l.classList.toggle("is-active", l.hash === `#${target.id}`);
  document.title = `${titleOf(target.id)} — Vellum Help`;
  if (scroll) {
    // Clear of the sticky nav, not the very top: the guide title should be
    // the first thing under it. Below 900px the index stacks *above* the
    // guide, so scroll past it to the guide itself.
    const anchor =
      window.innerWidth <= 900
        ? target
        : (document.querySelector(".help-shell") as HTMLElement);
    const top = anchor.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top, behavior: "smooth" });
  }
}

const fromHash = () => window.location.hash.replace(/^#/, "");
show(fromHash(), false);
window.addEventListener("hashchange", () => show(fromHash(), true));

/* ------------------------------------------------------------- search */

const search = document.querySelector<HTMLInputElement>(".help-search input");
const empty = document.querySelector<HTMLElement>(".help-index-empty");

if (search && empty) {
  // Every guide's own text is the haystack, so searching "formula" finds the
  // database guide even though the word isn't in its title.
  const haystack = new Map(
    guides.map((g) => [g.id, `${titleOf(g.id)} ${g.textContent ?? ""}`.toLowerCase()]),
  );

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    let matches = 0;
    for (const link of links) {
      const id = link.hash.replace(/^#/, "");
      const hit = !q || (haystack.get(id) ?? "").includes(q);
      link.hidden = !hit;
      if (hit) matches++;
    }
    // Hide a group heading whose links have all been filtered away.
    for (const group of document.querySelectorAll<HTMLElement>(".help-index-group")) {
      let el = group.nextElementSibling;
      let any = false;
      while (el && !el.classList.contains("help-index-group")) {
        if (el instanceof HTMLElement && !el.hidden) any = true;
        el = el.nextElementSibling;
      }
      group.hidden = !any;
    }
    empty.hidden = matches > 0;
  });
}

registerSW();
