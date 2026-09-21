export const getClientIP = (headers: Headers) => {
  const cfConnectingIp = headers.get("cf-connecting-ip");
  const xForwardedFor = headers.get("x-forwarded-for");

  if (cfConnectingIp) return cfConnectingIp;

  return xForwardedFor;
};

/**
 * Build a headers bag that forwards the originating client IP to Wake.
 * Passed per-call into the storefront GraphQL client.
 */
export const parseHeaders = (headers: Headers): Record<string, string> => {
  const clientIP = getClientIP(headers);
  const out: Record<string, string> = {};
  if (clientIP) out["X-Forwarded-For"] = clientIP;
  return out;
};
