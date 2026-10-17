import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fail} from './core.mjs';
let configured;
export function configureBrowser(adapter){if(typeof adapter?.withBrowser!=='function'||typeof adapter?.listTabs!=='function')fail('INVALID_ADAPTER','需要 withBrowser、listTabs');configured=adapter;}
async function getAdapter(){
 if(configured)return configured;
 try{return await import(process.env.QQ_CHANNEL_BROWSER_MODULE?pathToFileURL(path.resolve(process.env.QQ_CHANNEL_BROWSER_MODULE)).href:new URL('../../../bitbrowser/scripts/index.js',import.meta.url).href);}
 catch{fail('BROWSER_DEPENDENCY_MISSING','配置 QQ_CHANNEL_BROWSER_MODULE 或 configureBrowser；默认使用同级 bitbrowser');}
}
export const withBrowser=async(...a)=>(await getAdapter()).withBrowser(...a);
export const listTabs=async(...a)=>(await getAdapter()).listTabs(...a);
