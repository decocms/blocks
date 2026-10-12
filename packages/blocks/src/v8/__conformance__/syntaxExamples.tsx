/**
 * The docs' code examples for blocks, lazy-blocks, built-in-blocks and
 * matchers-and-variants, copied as written (imports point at the package, as
 * an app's would). Used by ./syntax.test.ts.
 */
import type { Blocks, Lazy, Page, Secret } from "@decocms/blocks";

// --- blocks.mdx › Functions as blocks: src/promo-banner.tsx -----------------
export interface PromoBannerProps {
  title: string;
  href: string;
}

export function PromoBanner({ title, href }: PromoBannerProps) {
  return <a href={href}>{title}</a>;
}

// --- a catalog the docs' productCard reads from ------------------------------
export interface Product {
  name: string;
  slug: string;
}

export const catalogCalls = { count: 0 };

export async function catalogProduct({ slug }: { slug: string }): Promise<Product> {
  catalogCalls.count++;
  return { name: slug === "summer-shirt" ? "Summer shirt" : slug, slug };
}

export function ProductCard({ title, product }: { title: string; product: Product }) {
  return (
    <div>
      {title}: {product.name}
    </div>
  );
}

export function productCard({ title, product }: { title: string; product: Product }) {
  return <ProductCard title={title} product={product} />;
}

// --- lazy-blocks.mdx › Lazy<T> props: src/product-card.tsx -------------------
function Title({ text }: { text: string }) {
  return <h2>{text}</h2>;
}
function Card({ title, product }: { title: string; product: Product }) {
  return (
    <div>
      {title}: {product.name}
    </div>
  );
}

export async function lazyProductCard({
  title,
  showProduct,
  product,
}: {
  title: string;
  showProduct: boolean;
  product: Lazy<Product>;
}) {
  if (!showProduct) return <Title text={title} />; // catalogProduct never runs
  const item = await product(); // catalogProduct runs here
  return <Card title={title} product={item} />;
}

// --- blocks.mdx › The block map: .deco/index.ts ------------------------------
export const blockMap = {
  "catalog-product": catalogProduct,
  "product-card": productCard,
  "promo-banner": PromoBanner,
} satisfies Blocks;

// --- built-in-blocks.mdx › Type a field as a secret: src/newsletter.tsx -----
export interface NewsletterProps {
  listId: string;
  /** @title API key */
  apiKey: Secret;
}

export function newsletter(props: NewsletterProps) {
  const key: string = props.apiKey; // "uses it like any string"
  return { listId: props.listId, keyLength: key.length };
}

// --- built-in-blocks.mdx › Change a built-in: .deco/index.ts -----------------
export const seo = (props: { title: string; description: string }) => props;
export const hero = (props: { title: string }) => <section>{props.title}</section>;

interface StorePage extends Page {
  theme: "light" | "dark";
}

const page = (props: StorePage) => props;

export const storeBlockMap = { seo, hero, page } satisfies Blocks;

// --- matchers-and-variants.mdx › Write your own matcher: src/matchers.ts ----
type Day = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export function weekday({
  days,
  timeZone = "America/New_York",
}: {
  days: Day[];
  timeZone?: string;
}) {
  const today = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date()); // "Sat"
  return days.some((day) => day === today);
}

export const weekdayBlockMap = { weekday, "promo-banner": PromoBanner } satisfies Blocks; // always, never, date, multivariate and lazy are built in

// --- matchers-and-variants.mdx › Combine rules / Skip an expensive rule ------
export const not = ({ rule }: { rule: boolean }) => !rule;
export const and = async ({ a, b }: { a: boolean; b: Lazy<boolean> }) => a && (await b());

// --- matchers-and-variants.mdx › Run an A/B test: src/matchers.ts -----------
export const visitor = { id: "visitor-1" };
const visitorId = () => visitor.id; // your app's anonymous visitor ID, kept in a cookie

const bucket = (key: string) =>
  [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 100;

/** @title A/B split */
export function split({ experiment, percent }: { experiment: string; percent: number }) {
  return bucket(`${experiment}:${visitorId()}`) < percent; // true for `percent`% of visitors
}

export { bucket };
