"use client";

import { useState } from "react";

export interface ClientHeroProps {
  label?: string;
}

export default function ClientHero({ label }: ClientHeroProps) {
  const [count, setCount] = useState(0);

  return (
    <button
      data-testid="client-hero"
      onClick={() => setCount((current) => current + 1)}
      type="button"
    >
      {`client-${label ?? "none"}-${count}`}
    </button>
  );
}
