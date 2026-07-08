import type { NextConfig } from "next";

export declare const DECO_REWRITES: Array<{ source: string; destination: string }>;
export declare function withDeco(nextConfig?: NextConfig): NextConfig;
