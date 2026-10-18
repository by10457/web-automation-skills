/** 狐友：回复动作封装。 */
import { prepareAction, performAction } from "./common.js";
export const prepareReply = (options) => prepareAction("reply", options);
export const reply = (options) => performAction("reply", options);
