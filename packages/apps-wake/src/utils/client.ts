/** Response shape of the Wake checkout REST endpoint `GET /api/Login/Get`. */
export interface UserAuthenticate {
  Cpf: string;
  CustomerAccessToken: string;
  Email: string;
  HasFirstPurchase: boolean;
  Id: string;
  Name: string;
  PhoneNumber: string;
  Type: number;
}
