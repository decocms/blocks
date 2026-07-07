import { createDecoPage } from "@decocms/nextjs";

// The plan brief's literal sketch was
// `export const { generateMetadata, default } = createDecoPage(...)` —
// invalid JS: `default` is a reserved word, so it cannot be used as a bare
// destructured binding name (`const { default } = x` is a syntax error).
// Destructure with an alias instead and re-export under the two names Next's
// App Router file convention actually looks for.
const page = createDecoPage({ siteName: "next-smoke-fixture" });

export const generateMetadata = page.generateMetadata;
export default page.default;
