/** 狐友：命令行参数与公开操作分发。 */
import path from "node:path";
import { withBrowser, listTabs, selectTab, SkillError } from "./lib/browser.js";
import { main, parseArgs } from "./lib/cli.js";
import { readSnapshot } from "./lib/snapshot.js";
import { pauseBeforeOperation } from "./lib/pacing.js";
import { preview, readJSON } from "./lib/runner.js";
import { runAction } from "./lib/actions/runner.js";
import { prepareBatch, runBatch } from "./lib/batch.js";
import { workspacePath } from "./config.js";
import { withHuyou } from "./session.js";
import { queryPosts, getPost } from "./posts.js";
import { loadMore, backToTop, refreshFeed } from "./navigation.js";
import {
  inspect,
  diagnoseHuyou,
  listCircles,
  selectCircle,
  setFeedSort,
  closePost,
} from "./context.js";
import { queryComments } from "./comments.js";
import { locatePost, openPost } from "./posts.js";
await main(async () => {
  const [command = "help", ...args] = process.argv.slice(2);
  if (
    [
      "diagnose",
      "circles",
      "select-circle",
      "sort",
      "query-comments",
      "locate-post",
      "open-post",
      "close-post",
    ].includes(command)
  ) {
    const o = parseArgs(args, [
      "workspace",
      "binding",
      "target",
      "name",
      "sort",
      "post",
      "query",
    ]);
    if (!o.binding) throw new SkillError("BINDING_REQUIRED", "需要 --binding");
    return withHuyou(
      {
        workspace: o.workspace,
        binding: o.binding,
        targetId: o.target,
        requireContext: !["diagnose", "circles", "select-circle"].includes(
          command,
        ),
      },
      async ({ page, binding }) => {
        if (command === "diagnose") return diagnoseHuyou(page, binding);
        if (command === "circles") return listCircles(page);
        if (command === "select-circle")
          return selectCircle(page, o.name, {
            expectedAccountName: binding.expectedAccountName,
          });
        if (command === "sort") return setFeedSort(page, o.sort);
        if (command === "close-post") {
          await closePost(page);
          return { status: "closed" };
        }
        const query = o.query ? await readJSON(path.resolve(o.query)) : {};
        if (command === "query-comments")
          return queryComments(page, binding, o.post, query);
        return (command === "locate-post" ? locatePost : openPost)(
          page,
          binding,
          o.post,
          query,
        );
      },
    );
  }
  if (command === "help" || command === "api-help")
    return {
      entry: "scripts/index.js",
      reference: "references/api.md",
      commands: [
        "diagnose --binding NAME --workspace DIR",
        "circles --binding NAME --workspace DIR",
        "select-circle --binding NAME --name CIRCLE --workspace DIR",
        "sort --binding NAME --sort SORT --workspace DIR",
        "query-comments --binding NAME --post ID --workspace DIR [--query FILE]",
        "locate-post --binding NAME --post ID --workspace DIR",
        "open-post --binding NAME --post ID --workspace DIR",
        "close-post --binding NAME --workspace DIR",
        "prepare --task FILE --workspace DIR",
        "rehearse --plan FILE --workspace DIR",
        "execute --plan FILE --workspace DIR",
        "reconcile --plan FILE --workspace DIR",
        "batch-prepare --task FILE --workspace DIR",
        "batch-execute --plan FILE --workspace DIR",
        "batch-rehearse --plan FILE --workspace DIR",
        "batch-reconcile --plan FILE --workspace DIR",
        "inspect --id ID [--target TAB_ID]",
        "query --binding NAME [--query FILE] [--workspace DIR]",
        "post --binding NAME --post ID [--workspace DIR]",
        "load-more --binding NAME [--workspace DIR]",
        "top --binding NAME [--workspace DIR]",
        "refresh --binding NAME [--workspace DIR]",
      ],
      configuration:
        "--workspace or HUYOU_WORKSPACE; explicit workspace required",
    };
  if (["query", "post", "load-more", "top", "refresh"].includes(command)) {
    const o = parseArgs(args, [
      "workspace",
      "binding",
      "target",
      ...(command === "query" ? ["query"] : command === "post" ? ["post"] : []),
    ]);
    if (!o.binding) throw new SkillError("BINDING_REQUIRED", "需要 --binding");
    const query =
      command === "query" && o.query
        ? await readJSON(path.resolve(o.query))
        : {};
    return withHuyou(
      { workspace: o.workspace, binding: o.binding, targetId: o.target },
      async ({ page, binding }) => {
        if (command === "query") return queryPosts(page, binding, query);
        if (command === "post") return getPost(page, o.post);
        return { "load-more": loadMore, top: backToTop, refresh: refreshFeed }[
          command
        ](page);
      },
    );
  }
  if (command.startsWith("batch-")) {
    const mode = command.slice(6);
    if (!["prepare", "rehearse", "execute", "reconcile"].includes(mode))
      throw new SkillError("UNKNOWN_COMMAND", "未知批次命令");
    const o = parseArgs(
      args,
      mode === "prepare" ? ["task", "workspace"] : ["plan", "workspace"],
    );
    if (!(mode === "prepare" ? o.task : o.plan))
      throw new SkillError("BATCH_FILE_REQUIRED", "需要 --task 或 --plan");
    const workspace = workspacePath(o.workspace);
    const result =
      mode === "prepare"
        ? await prepareBatch({
            workspace,
            task: await readJSON(path.resolve(o.task)),
          })
        : await runBatch({
            workspace,
            mode,
            manifest: await readJSON(path.resolve(o.plan)),
          });
    if (!["ready", "completed"].includes(result.status)) process.exitCode = 2;
    return result;
  }
  if (
    ["comments", "prepare", "rehearse", "execute", "reconcile"].includes(
      command,
    )
  ) {
    const allowed =
      command === "comments"
        ? ["binding", "post", "workspace", "target"]
        : command === "prepare"
          ? ["task", "workspace", "target"]
          : ["plan", "workspace", "target"];
    const o = parseArgs(args, allowed);
    if (command === "prepare" && !o.task)
      throw new SkillError("TASK_REQUIRED", "需要 --task");
    if (["rehearse", "execute", "reconcile"].includes(command) && !o.plan)
      throw new SkillError("PLAN_REQUIRED", "需要 --plan");
    if (command === "comments" && !o.binding)
      throw new SkillError("BINDING_REQUIRED", "需要 --binding");
    const result = await runAction({
      workspace: workspacePath(o.workspace),
      command,
      task: o.task ? await readJSON(path.resolve(o.task)) : undefined,
      plan: o.plan ? await readJSON(path.resolve(o.plan)) : undefined,
      bindingName: o.binding,
      postId: o.post,
      targetId: o.target,
    });
    if (["uncertain", "blocked-uncertain"].includes(result.status))
      process.exitCode = 2;
    return result;
  }
  if (command === "inspect") {
    await pauseBeforeOperation();
    const o = parseArgs(args, ["id", "name", "target"]);
    return withBrowser(o, async (browser, window) => {
      const tab = selectTab(await listTabs(browser), {
        origin: "https://hy.sns.sohu.com",
        targetId: o.target,
      });
      const s = await readSnapshot(tab.page);
      return {
        window,
        tab: { targetId: tab.targetId, url: tab.url },
        capturedAt: s.capturedAt,
        account: s.account,
        circle: s.circle,
        feed: s.feed,
        loadedCount: s.posts.length,
      };
    });
  }
  if (command === "preview") {
    const o = parseArgs(args, ["task", "workspace", "target"]);
    if (!o.task)
      throw new SkillError("TASK_REQUIRED", "请用 --task 指定任务 JSON");
    return preview({
      workspace: workspacePath(o.workspace),
      task: await readJSON(path.resolve(o.task)),
      targetId: o.target,
    });
  }
  throw new SkillError("UNKNOWN_COMMAND", "未知命令，运行 help 查看用法");
});
