#!/usr/bin/env node
/** 共享工作流的 JSON 参数适配入口；运行时必须显式指定模式。 */
import { readFile, writeFile } from "node:fs/promises";
import { createPostWorkflow } from "./workflow.js";

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    console.log(
      "node workflow-cli.js query|sample|freeze|prepare|run|handoff --input request.json [--output result.json]\nrequest: {workspace, ...operationArguments}; run.mode: rehearse|execute|reconcile. query/prepare/run may access pages; sample/freeze/handoff only access local files.",
    );
  } else {
    if (
      !["query", "sample", "freeze", "prepare", "run", "handoff"].includes(
        command,
      )
    )
      throw new Error("未知工作流命令");
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (
        !["--input", "--output"].includes(args[i]) ||
        !args[i + 1] ||
        args[i + 1].startsWith("--") ||
        options[args[i]]
      )
        throw new Error("需要唯一的 --input/--output 文件路径");
      options[args[i]] = args[i + 1];
    }
    if (!options["--input"]) throw new Error("缺少 --input");
    const { workspace, ...input } = JSON.parse(
      (await readFile(options["--input"], "utf8")).replace(/^\uFEFF/, ""),
    );
    if (typeof workspace !== "string" || !workspace.trim())
      throw new Error("必须显式指定 workspace");
    const data = await createPostWorkflow({ workspace })[command](input);
    const json = JSON.stringify({ ok: true, data }, null, 2) + "\n";
    if (options["--output"])
      await writeFile(options["--output"], json, { flag: "wx" });
    console.log(json.trimEnd());
    if (data.status && !["ready", "completed"].includes(data.status))
      process.exitCode = 2;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: { code: error.code || "WORKFLOW_FAILED", message: error.message },
    }),
  );
  process.exitCode = 1;
}
