import test from "node:test";
import assert from "node:assert/strict";
import { editableText } from "../scripts/lib/actions/dom.js";
test("paragraph editor preserves intentional blank lines without layout-generated spacing", () => {
  const el = {
    children: [
      { tagName: "P", innerText: "first" },
      { tagName: "P", innerText: "\n" },
      { tagName: "P", innerText: "second" },
    ],
    innerText: "first\n\n\n\n\nsecond",
  };
  assert.equal(editableText(el), "first\n\nsecond");
  assert.equal(editableText({ value: "first\n\nsecond" }), "first\n\nsecond");
});
