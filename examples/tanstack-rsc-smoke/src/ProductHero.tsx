import CartButton from "./CartButton";
import type { ProductHeroProps } from "./model";

export default function ProductHero({ name, price, currency, image }: ProductHeroProps) {
  const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price);
  return (
    <section>
      <img src={image} alt={name} />
      <h1>{name}</h1>
      <p>{formatted}</p>
      <CartButton />
    </section>
  );
}
