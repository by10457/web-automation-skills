/** 狐友：评论点赞动作封装。 */
import { prepareAction, performAction } from "./common.js";
export const prepareLikeComment = (options) =>
  prepareAction("like-comment", options);
export const likeComment = (options) => performAction("like-comment", options);
