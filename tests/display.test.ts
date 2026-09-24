import { expect, test } from "bun:test";
import { plain } from "../src/display";

test("untrusted diagnostics remain readable without terminal commands or control characters", () => {
  const input =
    "bad\u001b[31m key\u001b[0m\n\u001b]52;c;clipboard\u0007\u001b]0;title\u001b\\\u0008\u009b value";
  const displayed = plain(input, 200);
  expect(displayed).toBe("bad key value");
  expect(displayed).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
});

test("large diagnostics are bounded without splitting Unicode code points", () => {
  const displayed = plain("\u{1D11E}".repeat(40), 8);
  expect([...displayed]).toHaveLength(8);
  expect(displayed).toBe("\u{1D11E}".repeat(7) + "…");
});
