# Audit 5 — Intelligent Search cookies

VTEX IS requires `vtex_is_session` and `vtex_is_anonymous` cookies (UUIDs).

**Pattern in middleware.ts**:

```typescript
// Generate if missing
if (!cookieHeader.includes("vtex_is_session")) {
  const sessionId = crypto.randomUUID();
  // Set on response
}
```

Or, generating from existing request cookies:

```typescript
// middleware.ts
const vtexIsSession = cookies.get("vtex_is_session") ?? crypto.randomUUID();
const vtexIsAnonymous = cookies.get("vtex_is_anonymous") ?? crypto.randomUUID();
```

Pass to `intelligentSearch()` via `opts.cookieHeader`. An explicit
`cookieHeader` **replaces** the request's `vtex_segment` cookie that
`intelligentSearch()` forwards by default (`regionId` still goes on the query
string), so carry the segment along:

```typescript
const segment = cookies.get("vtex_segment"); // same request cookies as above
const data = await intelligentSearch<T>(path, params, {
  cookieHeader: [
    `vtex_is_session=${session}`,
    `vtex_is_anonymous=${anonymous}`,
    segment && `vtex_segment=${segment}`,
  ].filter(Boolean).join("; "),
  locale: "pt-BR",
});
```
