/**
 * `className` on React Native components comes from NativeWind's type
 * augmentation. This module only exists so the package type-checks on its own —
 * a consumer app already has the reference through its own `nativewind-env.d.ts`.
 *
 * NativeWind is an OPTIONAL peer: the rest of `@decocms/native` (renderJson
 * client, invoke, cookie jar, route policy) has nothing to do with styling. Only
 * `@decocms/native/daisy` needs it, because that is what emits the classes.
 */
/// <reference types="nativewind/types" />
