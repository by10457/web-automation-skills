/** 狐友：发布动作封装。 */
import { prepareAction, performAction } from "./common.js";
export const preparePublish = (options) => prepareAction("publish", options);
export const publish = (options) => performAction("publish", options);
