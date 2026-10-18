// Run after filling your own workspace binding. Default: query only.
import {
  withHuyou,
  queryPosts,
  prepareLikePost,
  likePost,
} from "../scripts/index.js";
const workspace = process.env.HUYOU_WORKSPACE;
if (!workspace) throw Error("Set HUYOU_WORKSPACE to your configured workspace");
const binding = process.argv[2];
if (!binding) throw Error("Provide a binding name");
const result = await withHuyou(
  { workspace, binding },
  ({ page, binding: expected }) => queryPosts(page, expected, { limit: 10 }),
);
console.log(JSON.stringify(result, null, 2));
// Only use after the user has authorized these exact target posts:
// for(const post of result.posts){
//   const plan=await prepareLikePost({workspace,binding,target:{postId:post.id}});
//   await likePost({workspace,plan,mode:'execute'});
// }
