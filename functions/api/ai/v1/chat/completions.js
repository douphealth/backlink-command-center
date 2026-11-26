import {chatCompletion} from '../../../../_lib/ai-writer.js';
export const onRequest=({request,env})=>chatCompletion(request,env);
