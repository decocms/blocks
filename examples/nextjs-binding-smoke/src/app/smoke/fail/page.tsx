// A page that fails on every request: the smoke's 5xx.
export const dynamic = "force-dynamic";

export default async function Fail(): Promise<never> {
  throw new Error("smoke: a failing page");
}
