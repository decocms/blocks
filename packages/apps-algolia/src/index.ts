/**
 * Algolia app entry point for @decocms/apps.
 * Re-exports client config + initializer + types.
 *
 * For loaders, use sub-path imports:
 *   import client from "@decocms/apps/algolia/loaders/client"
 *
 * For the SDK SearchClient directly (no proxy hop on the server):
 *   import { getAlgoliaClient } from "@decocms/apps/algolia/client"
 */
export * from "./client";
export type { AlgoliaConfig, Indices } from "./types";
