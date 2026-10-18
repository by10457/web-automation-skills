/** QQ 频道：写入完成后的页面恢复。 */
// 导航在写入确认后进行，导航失败不能成为重复提交的理由。
export async function finishPublishedPost(plan, result, returnToChannel) {
  if (plan.task.action !== "publish" || result.status !== "verified-ui")
    return result;
  try {
    return {
      ...result,
      returnToChannel: { status: "returned", result: await returnToChannel() },
    };
  } catch (e) {
    return {
      ...result,
      returnToChannel: {
        status: "failed",
        code: e.code || "RETURN_FAILED",
        message: e.message,
      },
      warnings: [
        ...(result.warnings || []),
        "帖子已发布；返回频道失败，不要重新发布",
      ],
    };
  }
}
