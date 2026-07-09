/**
 * VTEX Payment API loaders.
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/payment/paymentSystems.ts
 *   vtex/loaders/payment/userPayments.ts
 */
import { vtexIOGraphQL } from "../client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaymentSystem {
	name: string;
	groupName: string;
	requiresDocument: boolean;
	displayDocument: boolean;
	validator: {
		regex: string | null;
		mask: string | null;
		cardCodeMask: string | null;
		cardCodeRegex: string | null;
	};
}

export interface Payment {
	accountStatus: string | null;
	cardNumber: string;
	expirationDate: string;
	id: string;
	isExpired: boolean;
	paymentSystem: string;
	paymentSystemName: string;
}

// ---------------------------------------------------------------------------
// getPaymentSystems (authenticated — VTEX IO GraphQL)
// ---------------------------------------------------------------------------

const PAYMENT_SYSTEMS_QUERY = `query getPaymentSystems {
  paymentSystems {
    name
    groupName
    requiresDocument
    displayDocument
    validator {
      regex
      mask
      cardCodeMask
      cardCodeRegex
    }
  }
}`;

/**
 * List available payment systems for the authenticated user.
 * Requires a valid VTEX auth cookie.
 */
export async function getPaymentSystems(authCookie: string): Promise<PaymentSystem[]> {
	const { paymentSystems } = await vtexIOGraphQL<{
		paymentSystems: PaymentSystem[];
	}>({ query: PAYMENT_SYSTEMS_QUERY }, { cookie: authCookie });

	return paymentSystems;
}

// ---------------------------------------------------------------------------
// getUserPayments (authenticated — VTEX IO GraphQL)
// ---------------------------------------------------------------------------

const USER_PAYMENTS_QUERY = `query getUserPayments {
  profile {
    payments {
      accountStatus
      cardNumber
      expirationDate
      id
      isExpired
      paymentSystem
      paymentSystemName
    }
  }
}`;

/**
 * List saved payment methods for the authenticated user.
 * Requires a valid VTEX auth cookie.
 */
export async function getUserPayments(authCookie: string): Promise<Payment[]> {
	const data = await vtexIOGraphQL<{
		profile: { payments: Payment[] } | null;
	}>({ query: USER_PAYMENTS_QUERY }, { cookie: authCookie });

	return data.profile?.payments ?? [];
}
