import { hashPassword, randomToken, sha256, verifyPassword } from "../src/auth.ts";

Deno.test("password hash verifies only the original password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  if (!await verifyPassword("correct horse battery staple", hash)) {
    throw new Error("valid password was rejected");
  }
  if (await verifyPassword("wrong password", hash)) {
    throw new Error("invalid password was accepted");
  }
  if (hash.includes("correct horse battery staple")) {
    throw new Error("hash contains plain password");
  }
});

Deno.test("random tokens are URL-safe and unique", () => {
  const first = randomToken();
  const second = randomToken();
  if (!/^[A-Za-z0-9_-]+$/.test(first)) throw new Error("token is not URL-safe");
  if (first === second) throw new Error("tokens are equal");
});

Deno.test("sha256 is deterministic", async () => {
  if (await sha256("session") !== await sha256("session")) throw new Error("hashes differ");
});
