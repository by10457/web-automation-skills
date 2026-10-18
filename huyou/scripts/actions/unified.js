/** 狐友：统一操作准备与执行入口。 */
import { prepareAction, performAction } from "./common.js";
export function prepareInteraction(options) {
  const { action, ...rest } = options;
  return prepareAction(action, rest);
}
export function executeInteraction(options) {
  return performAction(options.plan?.task?.action, options);
}
