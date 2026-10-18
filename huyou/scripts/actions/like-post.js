/** 狐友：帖子点赞动作封装。 */
import { prepareAction, performAction } from "./common.js";
export const prepareLikePost = (options) => prepareAction("like-post", options);
export const likePost = (options) => performAction("like-post", options);
