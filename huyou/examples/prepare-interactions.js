// node prepare-interactions.js <absolute-workspace> <binding-name> <target-tab-id>
// 只查询和准备，不执行关注或点赞。
import {
  withHuyou,
  queryPosts,
  preparePostInteractions,
} from "../scripts/index.js";
const [workspace, binding, targetId] = process.argv.slice(2);
if (!workspace || !binding || !targetId)
  throw Error("需要 workspace、binding、targetId");
const { queryResult, self } = await withHuyou(
  { workspace, binding, targetId },
  async ({ page, binding }) => ({
    queryResult: await queryPosts(page, binding, { limit: 10, maxLoads: 10 }),
    self: binding.expectedAccountName,
  }),
);
console.log(
  JSON.stringify(
    await preparePostInteractions({
      workspace,
      binding,
      targetId,
      queryResult,
      action: "follow-user",
      excludeSelfName: self,
    }),
    null,
    2,
  ),
);
