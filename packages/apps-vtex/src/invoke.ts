/**
 * Typed `invoke.vtex.actions.*` object — generator contract.
 *
 * This file is the source of truth that `@decocms/start/scripts/generate-invoke.ts`
 * scans to emit the site-local `src/server/invoke.gen.ts`. The generator:
 *
 *   1. parses the imports in this file to learn which action lives where,
 *   2. walks `invoke.vtex.actions.*` and extracts each entry's:
 *      - validated input type (the arrow function's first parameter),
 *      - imported action function (matched against the import map by name),
 *      - output type (the outermost `as` cast's `Promise<...>` payload),
 *   3. emits a top-level `createServerFn` per action so TanStack Start's
 *      compiler can transform `.handler()` into client RPC stubs (the
 *      compiler only walks top-level decls, not factory-returned ones).
 *
 * Every action gets a `forwardResponseCookies()` call in the generated
 * handler — that bridges `Set-Cookie` headers captured by
 * `vtexFetchWithCookies` into TanStack Start's HTTP response. Without it,
 * `checkout.vtex.com` and `CheckoutOrderFormOwnership` never reach the
 * browser, and the storefront's mini-cart drifts away from VTEX's
 * server-side orderForm.
 *
 * To add a new action:
 *   1. Add an entry below with the input/output types and the action call,
 *   2. From a site repo: `npm run generate:invoke`.
 */
import { createInvokeFn } from "@decocms/tanstack/sdk/createInvoke";
import {
	addCouponToCart,
	addItemsToCart,
	getOrCreateCart,
	getSellersByRegion,
	type RegionResult,
	type SimulationItem,
	setShippingPostalCode,
	simulateCart,
	updateCartItems,
	updateOrderFormAttachment,
} from "./actions/checkout";
import {
	type CreateDocumentResult,
	createDocument,
	getDocument,
	patchDocument,
	searchDocuments,
	type UploadAttachmentOpts,
	uploadAttachment,
} from "./actions/masterData";
import { type NotifyMeProps, notifyMe } from "./actions/misc";
import { type SubscribeProps, subscribe } from "./actions/newsletter";
import { createSession, editSession, type SessionData } from "./actions/session";
import type { OrderForm } from "./types";

// ---------------------------------------------------------------------------
// invoke.vtex.actions — typed server functions callable from client
//
// Action bodies receive the validated input object directly and pass it
// straight to the action function (which expects a single `props` object).
// The arrow function body is what the generator parses for "which action
// is this entry calling" — keep the call site shaped as `actionName(data)`
// so the matcher in `generate-invoke.ts` picks the right importedFn.
// ---------------------------------------------------------------------------

export const invoke = {
	vtex: {
		actions: {
			// -- Cart (OrderForm CRUD) --------------------------------------------

			getOrCreateCart: createInvokeFn((data: { orderFormId?: string }) =>
				getOrCreateCart(data),
			) as unknown as (ctx: { data: { orderFormId?: string } }) => Promise<OrderForm>,

			addItemsToCart: createInvokeFn(
				(data: {
					orderFormId: string;
					orderItems: Array<{
						id: string;
						seller: string;
						quantity: number;
					}>;
				}) => addItemsToCart(data),
			) as unknown as (ctx: {
				data: {
					orderFormId: string;
					orderItems: Array<{
						id: string;
						seller: string;
						quantity: number;
					}>;
				};
			}) => Promise<OrderForm>,

			updateCartItems: createInvokeFn(
				(data: { orderFormId: string; orderItems: Array<{ index: number; quantity: number }> }) =>
					updateCartItems(data),
			) as unknown as (ctx: {
				data: { orderFormId: string; orderItems: Array<{ index: number; quantity: number }> };
			}) => Promise<OrderForm>,

			addCouponToCart: createInvokeFn((data: { orderFormId: string; text: string }) =>
				addCouponToCart(data),
			) as unknown as (ctx: { data: { orderFormId: string; text: string } }) => Promise<OrderForm>,

			simulateCart: createInvokeFn(
				(data: { items: SimulationItem[]; postalCode: string; country?: string }) =>
					simulateCart(data),
			),

			// -- Shipping / Region ------------------------------------------------

			getSellersByRegion: createInvokeFn((data: { postalCode: string; salesChannel?: string }) =>
				getSellersByRegion(data),
			) as unknown as (ctx: {
				data: { postalCode: string; salesChannel?: string };
			}) => Promise<RegionResult | null>,

			setShippingPostalCode: createInvokeFn(
				(data: { orderFormId: string; postalCode: string; country?: string }) =>
					setShippingPostalCode(data),
			) as unknown as (ctx: {
				data: { orderFormId: string; postalCode: string; country?: string };
			}) => Promise<boolean>,

			updateOrderFormAttachment: createInvokeFn(
				(data: { orderFormId: string; attachment: string; body: Record<string, unknown> }) =>
					updateOrderFormAttachment(data),
			) as unknown as (ctx: {
				data: { orderFormId: string; attachment: string; body: Record<string, unknown> };
			}) => Promise<OrderForm>,

			// -- Session ----------------------------------------------------------

			createSession: createInvokeFn((data: Record<string, any>) => createSession({ data })),

			editSession: createInvokeFn((data: { public: Record<string, { value: string }> }) =>
				editSession(data),
			) as unknown as (ctx: {
				data: { public: Record<string, { value: string }> };
			}) => Promise<SessionData>,

			// -- MasterData -------------------------------------------------------

			createDocument: createInvokeFn((data: { entity: string; data: Record<string, any> }) =>
				createDocument(data),
			) as unknown as (ctx: {
				data: { entity: string; data: Record<string, any> };
			}) => Promise<CreateDocumentResult>,

			getDocument: createInvokeFn((data: { entity: string; documentId: string }) =>
				getDocument(data),
			),

			patchDocument: createInvokeFn(
				(data: { entity: string; documentId: string; data: Record<string, any> }) =>
					patchDocument(data),
			) as unknown as (ctx: {
				data: { entity: string; documentId: string; data: Record<string, any> };
			}) => Promise<void>,

			searchDocuments: createInvokeFn((data: { entity: string; filter: string }) =>
				searchDocuments(data),
			),

			uploadAttachment: createInvokeFn((data: UploadAttachmentOpts) =>
				uploadAttachment(data),
			) as unknown as (ctx: { data: UploadAttachmentOpts }) => Promise<{ ok: true }>,

			// -- Newsletter -------------------------------------------------------

			subscribe: createInvokeFn((data: SubscribeProps) => subscribe(data)) as unknown as (ctx: {
				data: SubscribeProps;
			}) => Promise<void>,

			// -- Misc -------------------------------------------------------------

			notifyMe: createInvokeFn((data: NotifyMeProps) => notifyMe(data)) as unknown as (ctx: {
				data: NotifyMeProps;
			}) => Promise<void>,
		},
	},
} as const;
