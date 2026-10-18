// Read-only. Pass a JSON file containing workspace, binding and optional targetId.
import { readFile } from "node:fs/promises";
import { withQQChannel, queryPosts } from "../scripts/index.js";
if (!process.argv[2]) throw Error("Provide a request JSON file");
const options = JSON.parse(await readFile(process.argv[2], "utf8"));
console.log(
  JSON.stringify(
    await withQQChannel(options, ({ page, binding }) =>
      queryPosts(page, binding, { limit: 10 }),
    ),
    null,
    2,
  ),
);
