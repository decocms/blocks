import type { NextConfig } from "next";

// @decocms/blocks ships plain .ts source; Next compiles it only when told to.
const nextConfig: NextConfig = { transpilePackages: ["@decocms/blocks"] };

export default nextConfig;
