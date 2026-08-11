/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as admin from "../admin.js";
import type * as ai from "../ai.js";
import type * as auth from "../auth.js";
import type * as comments from "../comments.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_invites from "../lib/invites.js";
import type * as lib_linkMeta from "../lib/linkMeta.js";
import type * as lib_openrouter from "../lib/openrouter.js";
import type * as lib_pageLinks from "../lib/pageLinks.js";
import type * as lib_passwordPolicy from "../lib/passwordPolicy.js";
import type * as lib_publicHtml from "../lib/publicHtml.js";
import type * as lib_quotas from "../lib/quotas.js";
import type * as lib_sharing from "../lib/sharing.js";
import type * as lib_snippet from "../lib/snippet.js";
import type * as lib_versions from "../lib/versions.js";
import type * as linkPreview from "../linkPreview.js";
import type * as migrate from "../migrate.js";
import type * as pages from "../pages.js";
import type * as shares from "../shares.js";
import type * as versions from "../versions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  admin: typeof admin;
  ai: typeof ai;
  auth: typeof auth;
  comments: typeof comments;
  files: typeof files;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/invites": typeof lib_invites;
  "lib/linkMeta": typeof lib_linkMeta;
  "lib/openrouter": typeof lib_openrouter;
  "lib/pageLinks": typeof lib_pageLinks;
  "lib/passwordPolicy": typeof lib_passwordPolicy;
  "lib/publicHtml": typeof lib_publicHtml;
  "lib/quotas": typeof lib_quotas;
  "lib/sharing": typeof lib_sharing;
  "lib/snippet": typeof lib_snippet;
  "lib/versions": typeof lib_versions;
  linkPreview: typeof linkPreview;
  migrate: typeof migrate;
  pages: typeof pages;
  shares: typeof shares;
  versions: typeof versions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
