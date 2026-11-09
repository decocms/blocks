# Email and personalization: Resend, SFMC Personalization

Two small clients with one operation each. Both are POSTs, so neither is retried, and
neither may be cached.

## `@decocms/apps-resend`

```ts
import { createResendClient } from "@decocms/apps-resend";

export const resend = createResendClient({ apiKey: secrets.RESEND_API_KEY });

const { id } = await resend.sendEmail({
  from: "Store <contact@store.example.com>",
  to: ["shopper@example.com"],
  subject: "Your quote",
  html: "<p>…</p>",
  reply_to: "sales@store.example.com",
});
```

- `sendEmail(email)` posts to `https://api.resend.com/emails` with
  `Authorization: Bearer <apiKey>` and returns `{ id }`.
- `from` is required by the type: the API needs a sender. Other fields: `to`, `subject`,
  `cc`, `bcc`, `reply_to`, `html`, `text`, `headers`.
- No retries or circuit breaker: sending an email isn't safe to repeat. On
  `ResendError` (`operation`, `status`), decide in the site whether to retry.
- Default sender, recipients and subject belong to the site. A migrated site has them
  in `resendSettings` (`emailFrom`, `emailTo`, `subject`) in `src/clients/resend.ts`;
  v7's default sender was `Contact <onboarding@resend.dev>`.
- Exports: `createResendClient`, `ResendClient`, `ResendClientConfig`, `ResendError`,
  `SendEmailOptions`, `CreateEmailOptions`, `CreateEmailResponseSuccess`.

Send from a server function or route handler (a contact form, a newsletter sign-up).
Validate and rate-limit the input there: the key sends mail as the store.

## `@decocms/apps-sfmc-personalization`

Salesforce Marketing Cloud Personalization (formerly Evergage), Event API.

```ts
import { createSfmcPersonalizationClient } from "@decocms/apps-sfmc-personalization";

export const sfmc = createSfmcPersonalizationClient({
  baseUrl: "https://<account>.<instance>.evergage.com",
  dataset: "engage",
});

const { campaignResponses } = await sfmc.sendEvent({
  source: { channel: "Web", url: pageUrl },
  interaction: { name: "View Item" },
  user: { anonymousId },
  pageView: true,
});
```

- `sendEvent(event)` posts to `/api2/event/{dataset}` on `baseUrl` and returns the
  campaigns the interaction triggered: `campaignResponses[]`, each with `campaignId` and
  a `payload` (`experience`, `headerText`, `products`, `userGroup`, and whatever the
  campaign defines).
- `event.user` carries `anonymousId`, `encryptedId` or `attributes`; `interaction` can
  carry `lineItems` for cart-aware events; `flags` has `nonInteractive` and `doNotTrack`.
- `PersonalizationProduct` keeps the common product fields (`id`, `name`, `price`,
  `salePrice`, `inventoryCount`, `imageUrls`, `url`, `currency`) and accepts the rest
  of the dataset's catalog fields.
- The client sends no credentials. Reading the shopper's ID from its cookie, mapping
  products to commerce types and any caching are site code.
- Errors: `SfmcPersonalizationError` (`operation`, `status`). No retries.
- Exports: `createSfmcPersonalizationClient`, `SfmcPersonalizationClient`,
  `SfmcPersonalizationConfig`, `SfmcPersonalizationError`, and the types
  `PersonalizationEvent`, `PersonalizationResponse`, `CampaignResponse`,
  `PersonalizationProduct`, `PersonalizationLineItem`.

The response depends on the shopper, so a section that renders campaign products is
per-visitor. Fetch it after the page loads, or from a private server function, so the
page itself stays cacheable.
