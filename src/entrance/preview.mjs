import {publicEntrance,publicResponse} from './handler.mjs';

export default {async fetch(request,env) {
  try {
    return await publicEntrance(request,env.ASSETS) ?? publicResponse('Private workspace: this local entrance preview has no working workspace connection.',401);
  } catch { return publicResponse('The entrance could not be opened.',502); }
}};
