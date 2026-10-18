import test from "node:test";
import assert from "node:assert/strict";
import { pauseBeforeOperation } from "../scripts/lib/pacing.js";
test("every operation awaits a sampled delay within the requested range", async () => {
  for (const ms of [1000, 3124, 5000]) {
    let waited;
    assert.equal(
      await pauseBeforeOperation({
        sample: () => ms,
        sleep: async (n) => {
          waited = n;
        },
      }),
      ms,
    );
    assert.equal(waited, ms);
  }
  await assert.rejects(
    pauseBeforeOperation({ sample: () => 999, sleep: () => assert.fail() }),
  );
});
