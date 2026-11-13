// Render on demand so the smoke tests a served failure, never a failed build.
export const dynamic = "force-dynamic";

export default function RenderErrorPage(): never {
  throw new Error("local render smoke failed");
}
