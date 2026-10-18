/** 狐友：评论动作封装。 */
import { prepareAction, performAction } from "./common.js";
export const prepareComment = (options) => prepareAction("comment", options);
export const comment = (options) => performAction("comment", options);
