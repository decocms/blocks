// A route on the Edge runtime: measured by the Node.js server that serves it under `next start`.
export const runtime = "edge";

export function GET() {
  return new Response("edge", { headers: { "content-type": "text/plain" } });
}
