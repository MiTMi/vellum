/**
 * The legal pages' runtime — help.ts minus the search box: one document at
 * a time chosen by the URL hash (#privacy / #terms / #license), prev/next
 * from index order, and the landing chrome (nav border, footer year, CTA
 * copy flip). Reuses the Help Center's classes so help.css styles it.
 */

import "@blocknote/core/fonts/inter.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "../landing/landing.css";
import "../help/help.css";
import { registerSW } from "../pwa/register";

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

const docs = [...document.querySelectorAll<HTMLElement>(".guide")];
const links = [...document.querySelectorAll<HTMLAnchorElement>(".help-index a")];
const titleOf = (id: string) =>
  links.find((l) => l.hash === `#${id}`)?.textContent?.trim() ?? id;

function show(id: string, scroll: boolean): void {
  const target = docs.find((g) => g.id === id) ?? docs[0];
  for (const g of docs) g.classList.toggle("is-open", g === target);
  for (const l of links) l.classList.toggle("is-active", l.hash === `#${target.id}`);
  document.title = `${titleOf(target.id)} — Vellum`;
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

const fromHash = () => window.location.hash.replace(/^#/, "");
show(fromHash(), false);
window.addEventListener("hashchange", () => show(fromHash(), true));

registerSW();
