/**
 * The landing page's entire runtime. Deliberately tiny and React-free — the
 * page is static markup, so the only dynamic bits are the scroll shadow on
 * the nav, the footer year, and swapping CTA copy for a returning visitor.
 */

// Inter ships with BlockNote, so the landing page reuses it rather than
// pulling a font off a CDN. Imported here (not linked in the HTML) so Vite
// bundles it into the landing entry's stylesheet.
import "@blocknote/core/fonts/inter.css";
import "./landing.css";
import { registerSW } from "../pwa/register";

/** Same flag `Auth.tsx` writes once Convex confirms the owner's identity. */
const SESSION_FLAG = "vellum:hasSession";

function hasLocalSession(): boolean {
  try {
    return localStorage.getItem(SESSION_FLAG) === "1";
  } catch {
    return false;
  }
}

// Someone who has signed in on this device isn't "getting started" any more.
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

// Installing from "/" primes the same shell cache the workspace boots from.
registerSW();
