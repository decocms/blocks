// The thin Wake client (see /next/upstream-clients). Operations are in
// `@decocms/apps-wake/storefront`, their types in `.../storefront/types`.

export type { UserAuthenticate } from "./utils/client.ts";
export {
  createWakeClient,
  type WakeClient,
  type WakeClientConfig,
  type WakeClientOptions,
  WakeError,
} from "./wakeClient.ts";
