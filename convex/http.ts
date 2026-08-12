import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { renderPublicPage } from "./lib/publicHtml";

const http = httpRouter();

auth.addHttpRoutes(http);

/**
 * Publicly served copy of a page the owner chose to publish.
 *
 * This is the one route in the app that deliberately runs without
 * authentication. Its access control is the slug: only a page carrying that
 * exact `publicSlug` (and not trashed) resolves, and `pages.bySlug` returns
 * just the fields rendered here — no ids, no children, no sibling pages.
 */
http.route({
  pathPrefix: "/p/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const slug = decodeURIComponent(
      new URL(request.url).pathname.slice("/p/".length),
    ).replace(/\/$/, "");

    // Belt to bySlug's suspenders: any future throw inside the lookup
    // must degrade to the not-found page, never a raw 500 on the one
    // unauthenticated route.
    let page;
    try {
      page = await ctx.runQuery(internal.pages.bySlug, { slug });
    } catch (err) {
      console.error("bySlug failed for a published page:", err);
      page = null;
    }
    if (!page) {
      return new Response(
        renderPublicPage({
          title: "Page not found",
          blocks: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "This link is no longer available.",
                  styles: {},
                },
              ],
            },
          ],
          updatedAt: Date.now(),
        }),
        { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    return new Response(
      renderPublicPage({
        title: page.title,
        icon: page.icon,
        blocks: page.content,
        updatedAt: page.updatedAt,
        titles: page.titles,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // Short cache: edits should appear quickly, but a shared link that
          // gets traffic shouldn't hit the database on every hit.
          "Cache-Control": "public, max-age=60",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  }),
});

export default http;
