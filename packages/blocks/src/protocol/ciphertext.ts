/**
 * The secret ciphertext format. The implementation is a dependency-free leaf
 * module of the SDK (`src/v8/ciphertext.ts`), where the `secret` built-in
 * decrypts it; the protocol re-exports it for its secret guard.
 */
export * from "../v8/ciphertext";
