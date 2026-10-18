/** 狐友：公开导出入口，供业务脚本组合调用已封装能力。 */
export {
  createCommentBrief,
  exportReadOnlyHandoff,
} from "./read-only-handoff.js";
export { withHuyou } from "./session.js";
export { createPostWorkflow } from "./workflow.js";
export { prepareInteraction, executeInteraction } from "./actions/unified.js";
export {
  listOperations,
  recordOperationEvidence,
  recoverInteractionPage,
  recoverOwnedDraft,
  classifyInteractionResult,
} from "./operations.js";
export {
  interactionBatchFromPosts,
  preparePostInteractions,
} from "./batch-targets.js";
export {
  openUserProfile,
  readUserProfile,
  closeUserProfile,
  withUserProfile,
} from "./profiles.js";
export { prepareFollowUser, followUser } from "./actions/follow-user.js";
export { configureBrowser } from "./lib/browser.js";
export {
  inspect,
  diagnoseHuyou,
  listCircles,
  selectCircle,
  setFeedSort,
  closePost,
} from "./context.js";
export { queryComments, loadMoreComments, resolveComment } from "./comments.js";
export { locatePost, openPost } from "./posts.js";
export { workspacePath } from "./config.js";
export {
  queryPosts,
  getPost,
  resolvePost,
  parsePostTime,
  normalizeQuery,
  filterPosts,
} from "./posts.js";
export { loadMore, backToTop, refreshFeed } from "./navigation.js";
export { prepareLikePost, likePost } from "./actions/like-post.js";
export { prepareLikeComment, likeComment } from "./actions/like-comment.js";
export { prepareComment, comment } from "./actions/comment.js";
export { prepareReply, reply } from "./actions/reply.js";
export { preparePublish, publish } from "./actions/publish.js";
export { prepareBatch, runBatch } from "./lib/batch.js";
export {
  collectLatestPosts,
  selectIndependentPosts,
  buildIndependentBatch,
} from "./business.js";
