/** 狐友：页面操作间隔控制。 */
import { randomInt } from "node:crypto";
export async function pauseBeforeOperation({
  sample = () => randomInt(1000, 5001),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const delayMs = sample();
  if (!Number.isInteger(delayMs) || delayMs < 1000 || delayMs > 5000)
    throw new Error("Operation delay must be 1000–5000 ms");
  await sleep(delayMs);
  return delayMs;
}
