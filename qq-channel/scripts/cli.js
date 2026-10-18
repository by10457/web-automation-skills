#!/usr/bin/env node
/** QQ 频道：命令行参数与公开操作分发。 */
import * as api from "./index.js";
import { readJSON, saveJSON, fail } from "./lib/core.js";
const args = process.argv.slice(2),
  command = args.shift();
const help =
  "用法：node scripts/cli.js <inspect|diagnose|channels|select-channel|views|select-view|initialize-views|posts|post|comments|load-more|load-comments|top|refresh|prepare|execute|reconcile|operations> --input request.json [--output result.json]";
try {
  if (!command || command === "--help") {
    console.log(help);
  } else {
    const flags = {};
    while (args.length) {
      const key = args.shift(),
        value = args.shift();
      if (!["--input", "--output"].includes(key) || !value || flags[key])
        fail("INVALID_CLI", help);
      flags[key] = value;
    }
    if (!flags["--input"]) fail("INVALID_CLI", help);
    const request = await readJSON(flags["--input"]);
    let result;
    if (command === "prepare") result = await api.prepareInteraction(request);
    else if (["execute", "reconcile"].includes(command)) {
      const plan = request.plan || (await readJSON(request.planFile));
      result = await api.executeInteraction({
        ...request,
        plan,
        mode: command,
      });
    } else if (command === "operations")
      result = await api.listOperations(request);
    else {
      const readers = {
        inspect: ({ page }) => api.inspect(page),
        diagnose: ({ page, binding }) => api.diagnose(page, binding),
        channels: ({ page }) => api.listChannels(page),
        "select-channel": ({ page, binding }) =>
          api.selectChannel(page, binding, request.target),
        views: ({ page, binding }) => api.listPostViews(page, binding),
        "select-view": ({ page, binding }) =>
          api.selectPostView(page, binding, request.view),
        "initialize-views": ({ page, binding }) =>
          api.initializePostViews(page, binding),
        posts: ({ page, binding }) =>
          api.queryPosts(page, binding, request.query),
        post: ({ page, binding }) => api.getPost(page, binding, request.url),
        comments: ({ page, binding }) =>
          api.queryComments(page, binding, request.query),
        "load-more": ({ page, binding }) => api.loadMore(page, binding),
        "load-comments": ({ page, binding }) =>
          api.loadMoreComments(page, binding),
        top: ({ page, binding }) => api.backToTop(page, binding),
        refresh: ({ page, binding }) => api.refreshFeed(page, binding),
      };
      if (!readers[command]) fail("INVALID_COMMAND", help);
      result = await api.withQQChannel(
        {
          ...request,
          requireContext: ![
            "inspect",
            "diagnose",
            "channels",
            "select-channel",
          ].includes(command),
        },
        readers[command],
      );
    }
    if (flags["--output"]) await saveJSON(flags["--output"], result);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) {
  console.error(
    JSON.stringify({
      status: "blocked",
      code: e.code || "UNEXPECTED_ERROR",
      message: e.message,
      ...(e.runDir ? { runDir: e.runDir } : {}),
    }),
  );
  process.exitCode = 1;
}
