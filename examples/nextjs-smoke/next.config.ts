import type { NextConfig } from "next";

// No transpilePackages: @decocms/blocks ships compiled JavaScript (dist/, one
// .js per source file), which Next loads from node_modules like any package.
const nextConfig: NextConfig = {};

export default nextConfig;
