import {listModels} from '../../../_lib/ai-writer.js';
export const onRequest=({request,env})=>listModels(request,env);
