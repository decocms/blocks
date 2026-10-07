/** Server-side validation (Nuvemshop validates none of this) and pt-BR error mapping. */

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Positive integer id from untrusted input (number or plain digit string), else null. "1,2", "12/x", "1e3", " 1" -> null. */
export function parseId(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** CPF with check digits. ponytail: CPF only, no CNPJ; add when business accounts are needed. */
export function isValidCpf(input: string): boolean {
  const d = input.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    return ((s * 10) % 11) % 10;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/** Brazilian phone (DDD + 8/9 digits, optional +55) -> "+55DDDNNNNNNNNN", or null if invalid. */
export function normalizePhone(input: string): string | null {
  let d = input.replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  if (d.length < 10 || d.length > 11 || d[0] === "0" || d[1] === "0") return null;
  if (d.length === 11 && d[2] !== "9") return null;
  return `+55${d}`;
}

const FIELD_LABELS: Record<string, string> = {
  name: "nome",
  email: "e-mail",
  phone: "telefone",
  identification: "CPF",
  address: "endereço",
  number: "número",
  locality: "bairro",
  city: "cidade",
  province: "estado",
  zipcode: "CEP",
};

/** Admin 422 `{field: [msg]}` -> pt-BR. */
export function mapAdminError(status: number, body: unknown): AccountError {
  if (status === 401 || status === 403) return new AccountError("Acesso negado.", 403);
  if (status === 404) return new AccountError("Não encontrado.", 404);
  if (status === 429)
    return new AccountError("Muitas tentativas. Tente novamente em instantes.", 429);
  if (status === 422 && body && typeof body === "object") {
    const fields = Object.keys(body)
      .map((k) => FIELD_LABELS[k.replace(/^billing_/, "")] ?? k)
      .join(", ");
    return new AccountError(`Confira os dados informados (${fields}).`, 422);
  }
  return new AccountError("Não foi possível concluir agora. Tente novamente.", 502);
}
