import { sha256Hex } from "../../src/services/checksum.js";
test("sha256 hex of 'hello' matches", () => {
  const buf = Buffer.from("hello");
  const h = sha256Hex(buf);
  expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});
