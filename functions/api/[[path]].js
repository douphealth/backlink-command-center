/** Cloudflare-native API. D1 storage, Cloudflare Access login, no VPS. */
import {handleApi} from '../_lib/api.js';
export async function onRequest(context){return handleApi(context.request,context.env);}
