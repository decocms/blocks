/** Order mapping (Admin API -> small UI type) and pt-BR status labels. Pure, no I/O. */

export interface OrderItem {
  name: string;
  quantity: number;
  price: number;
  image?: string;
  variant?: string;
}

export interface Order {
  id: number;
  number: number;
  createdAt: string;
  total: number;
  currency: string;
  paymentStatus: string;
  shippingStatus: string;
  status: string;
  /** Single buyer-facing label (see `orderStatusLabel`). */
  statusLabel: string;
  items: OrderItem[];
  trackingUrl?: string;
}

export interface Address {
  id: number;
  name?: string | null;
  address: string;
  number: string;
  floor?: string | null;
  locality: string;
  city: string;
  province: string;
  zipcode: string;
  country: string;
  phone?: string | null;
  default?: boolean;
}

export interface OrderDetail extends Order {
  subtotal: number;
  discount: number;
  shipping: number;
  paymentMethod?: string;
  paidAt?: string | null;
  shippingAddress?: Partial<Address> & { name?: string | null };
  tracking: { code?: string; url?: string }[];
}

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: "Pagamento pendente",
  authorized: "Pagamento autorizado",
  paid: "Pago",
  partially_paid: "Parcialmente pago",
  abandoned: "Abandonado",
  refunded: "Reembolsado",
  partially_refunded: "Parcialmente reembolsado",
  voided: "Pagamento cancelado",
};

export const SHIPPING_STATUS_LABEL: Record<string, string> = {
  unpacked: "Em preparação",
  partially_packed: "Em preparação",
  unshipped: "Aguardando envio",
  partially_fulfilled: "Parcialmente enviado",
  shipped: "Enviado",
  delivered: "Entregue",
};

/** cancelled > unpaid/refunded payment > shipping progress. */
export function orderStatusLabel(o: {
  status?: string;
  payment_status?: string;
  shipping_status?: string;
}): string {
  if (o.status === "cancelled") return "Cancelado";
  const pay = o.payment_status ?? "";
  if (pay !== "paid" && PAYMENT_STATUS_LABEL[pay]) return PAYMENT_STATUS_LABEL[pay];
  return (
    SHIPPING_STATUS_LABEL[o.shipping_status ?? ""] ?? PAYMENT_STATUS_LABEL[pay] ?? "Em andamento"
  );
}

type Raw = any;

// Real API dates end in "+0000" (no colon), which Safari's Date rejects.
const iso = (v: unknown) => (typeof v === "string" ? v.replace(/([+-]\d\d)(\d\d)$/, "$1:$2") : v);
const num = (v: unknown) => Number(v) || 0;
// Names can be localized objects ({pt, es}) on some endpoints.
const text = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" ? String(Object.values(v)[0] ?? "") : "";

export function mapOrder(o: Raw): Order {
  const tracking = o.fulfillments?.flatMap((f: Raw) =>
    f.tracking_info?.url ? [f.tracking_info.url] : [],
  );
  return {
    id: o.id,
    number: o.number,
    createdAt: iso(o.created_at) as string,
    total: num(o.total),
    currency: o.currency ?? "BRL",
    paymentStatus: o.payment_status,
    shippingStatus: o.shipping_status,
    status: o.status,
    statusLabel: orderStatusLabel(o),
    items: (o.products ?? []).map((p: Raw) => ({
      // `name` embeds the variant, e.g. "Camisa (P, Azul)"; variant is shown separately.
      name: text(p.name_without_variants ?? p.name),
      quantity: num(p.quantity),
      price: num(p.price),
      image: typeof p.image === "string" ? p.image : p.image?.src,
      variant: Array.isArray(p.variant_values)
        ? p.variant_values.join(" / ") || undefined
        : undefined,
    })),
    trackingUrl: tracking?.[0] ?? o.shipping_tracking_url ?? undefined,
  };
}

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  credit_card: "Cartão de crédito",
  debit_card: "Cartão de débito",
  boleto: "Boleto",
  pix: "Pix",
};
// Draft/manual orders report method "other" and gateway "not-provided".

export function mapOrderDetail(o: Raw): OrderDetail {
  const pd = o.payment_details ?? {};
  const sa = o.shipping_address;
  return {
    ...mapOrder(o),
    subtotal: num(o.subtotal),
    discount: num(o.discount),
    shipping: num(o.shipping_cost_customer),
    paymentMethod:
      pd.method === "other"
        ? undefined
        : (PAYMENT_METHOD_LABEL[pd.method] ?? pd.method ?? undefined),
    paidAt: (iso(o.paid_at) as string) ?? null,
    // Explicit pick: never spread the raw object (billing/owner data).
    shippingAddress: sa && {
      name: sa.name,
      address: sa.address,
      number: sa.number,
      floor: sa.floor,
      locality: sa.locality,
      city: sa.city,
      province: sa.province,
      zipcode: sa.zip ?? sa.zipcode,
      country: sa.country,
      phone: sa.phone,
    },
    tracking: (o.fulfillments ?? [])
      .filter((f: Raw) => f.tracking_info?.code || f.tracking_info?.url)
      .map((f: Raw) => ({
        code: f.tracking_info.code ?? undefined,
        url: f.tracking_info.url ?? undefined,
      })),
  };
}
