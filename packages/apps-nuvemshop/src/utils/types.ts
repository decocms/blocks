/**
 * Nuvemshop (Tiendanube) Storefront API `v2026-11` response shapes.
 *
 * Source of truth: the OpenAPI 0.5.0 document plus real responses captured in
 * `src/__fixtures__` — the fixtures are assigned to these types in tests, so a
 * drift between the API and these declarations fails `tsc`.
 *
 * Money fields arrive as decimal strings ("189.90"). `compare_at_price` equals
 * `price` when there's no discount; a sale shows up as `promotional_price`.
 */

export interface NuvemshopImage {
  id: number;
  src: string;
  alt: string | null;
  height?: number | null;
  width?: number | null;
}

export interface NuvemshopInventoryLevel {
  id: number;
  variant_id: number;
  location_id: string;
  stock: number | null;
}

export interface NuvemshopVariant {
  id: number;
  product_id: number;
  image_id: number | null;
  position: number;
  price: string | null;
  price_without_taxes?: string | null;
  compare_at_price: string | null;
  promotional_price: string | null;
  stock_management: boolean;
  stock: number | null;
  sku: string | null;
  /** Aligned by index with the product's `attributes` (e.g. ["P", "Azul"] ↔ ["Tamanho", "Cor"]). */
  values: string[];
  barcode: string | null;
  weight?: string | null;
  visible?: boolean;
  created_at?: string;
  updated_at?: string;
  /** Returned by the public API — never copy it into commerce types (cost price). */
  cost?: string | null;
  mpn?: string | null;
  age_group?: string | null;
  gender?: string | null;
  width?: string | null;
  height?: string | null;
  depth?: string | null;
  inventory_levels?: NuvemshopInventoryLevel[];
}

export interface NuvemshopCategoryRef {
  id: number;
  name: string;
  handle: string;
  parent: number | null;
  google_shopping_category?: string;
}

export interface NuvemshopCustomField {
  key: string;
  value: string;
}

export interface NuvemshopProduct {
  id: number;
  name: string;
  handle: string;
  description?: string;
  images?: NuvemshopImage[];
  variants?: NuvemshopVariant[];
  brand?: string | null;
  /** Comma-separated. */
  tags?: string;
  categories?: NuvemshopCategoryRef[];
  attributes?: string[];
  seo_title?: string;
  seo_description?: string;
  published?: boolean;
  free_shipping?: boolean;
  video_url?: string | null;
  custom_fields?: NuvemshopCustomField[];
  created_at?: string;
}

export interface NuvemshopCategory {
  id: number;
  name: string;
  handle: string;
  parent?: number | null;
  subcategories?: number[];
  description?: string;
  seo_title?: string;
  seo_description?: string;
}

export interface NuvemshopPagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface NuvemshopList<T> {
  data: T[];
  pagination: NuvemshopPagination;
}

export type NuvemshopSort = "best-selling" | "price-ascending" | "price-descending";

export interface NuvemshopShippingOption {
  code: string;
  name: string;
  price: string;
  detail?: string;
  date?: string;
  days_until?: { start: number; end: number; working_start: number; working_end: number };
}

export interface NuvemshopShippingOptions {
  shipping_options: NuvemshopShippingOption[];
}

export interface NuvemshopLineItem {
  product_id: number;
  variant_id: number;
  quantity: number;
}

export interface NuvemshopCheckout {
  checkout_url: string;
}

export interface NuvemshopError {
  error: { code: string; message: string; details?: unknown };
}
