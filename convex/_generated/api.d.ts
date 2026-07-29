/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as files from "../files.js";
import type * as lib_linkMeta from "../lib/linkMeta.js";
import type * as lib_pageLinks from "../lib/pageLinks.js";
import type * as lib_versions from "../lib/versions.js";
import type * as linkPreview from "../linkPreview.js";
import type * as pages from "../pages.js";
import type * as versions from "../versions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  files: typeof files;
  "lib/linkMeta": typeof lib_linkMeta;
  "lib/pageLinks": typeof lib_pageLinks;
  "lib/versions": typeof lib_versions;
  linkPreview: typeof linkPreview;
  pages: typeof pages;
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
