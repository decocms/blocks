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

Pass to `intelligentSearch()` via `opts.cookieHeader`:

```typescript
const data = await intelligentSearch<T>(path, params, {
  cookieHeader: `vtex_is_session=${session}; vtex_is_anonymous=${anonymous}`,
  locale: "pt-BR",
});
```
