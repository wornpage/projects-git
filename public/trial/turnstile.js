let scriptPromise;
export function loadTurnstile() {
  if(window.turnstile)return Promise.resolve(window.turnstile);
  if(!scriptPromise)scriptPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;
    const timeout=setTimeout(()=>fail(),15000);
    function fail(){clearTimeout(timeout);script.remove();scriptPromise=null;reject(Error('Security check unavailable'));}
    script.addEventListener('load',()=>{clearTimeout(timeout);if(window.turnstile)resolve(window.turnstile);else fail();},{once:true});
    script.addEventListener('error',fail,{once:true});document.head.append(script);
  });
  return scriptPromise;
}

// The token lives only in this page's closure. It never enters stored trial
// state, the URL, analytics, local storage or a workflow receipt.
export function createTrialVerification({root,loadApi=loadTurnstile,compact=()=>matchMedia('(max-width:380px)').matches}={}) {
  let generation=0,token='',api=null,widget=null;
  function clear(){generation++;token='';if(widget!==null){api.remove(widget);widget=null;}}
  function sync(state){
    clear();if(state.phase!=='eligible')return;
    const current=generation,container=root.querySelector('#trial-turnstile'),button=root.querySelector('#reserve-trial');
    const message=root.querySelector('#trial-turnstile-status'),retry=root.querySelector('#trial-turnstile-retry');
    if(!container||!button||!message||!retry)return;
    const active=()=>current===generation;
    const invalidate=text=>{if(!active())return;token='';button.disabled=true;message.textContent=text;retry.hidden=false;};
    retry.onclick=()=>{if(active())sync(state);};
    button.disabled=true;retry.hidden=true;message.textContent='Loading security check…';
    void loadApi().then(loaded=>{
      if(!active())return;api=loaded;
      widget=api.render(container,{sitekey:state.identity.turnstile.siteKey,action:state.identity.turnstile.action,
        theme:'light',size:compact()?'compact':'flexible',retry:'never','refresh-expired':'manual',
        callback:value=>{if(!active())return;if(typeof value!=='string'||!value||value.length>2048){invalidate('Security check failed. Try again.');return;}
          token=value;button.disabled=false;message.textContent='Security check complete.';retry.hidden=true;},
        'expired-callback':()=>invalidate('Security check expired. Try again.'),
        'error-callback':()=>{invalidate('Security check unavailable. Try again.');return true;},
        'timeout-callback':()=>invalidate('Security check timed out. Try again.'),
      });
    }).catch(()=>invalidate('Security check could not load. Check your connection and try again.'));
  }
  return {sync,clear,take(){const value=token;token='';const button=root.querySelector('#reserve-trial');if(button)button.disabled=true;return value;}};
}
