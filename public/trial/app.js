import {createTrialClient} from './client.js';
import {renderTrial} from './view.js';
import {createTrialVerification} from './turnstile.js';

if(location.pathname==='/trial/signup') {
  document.body.classList.add('signup-active');
  document.getElementById('trial-title').textContent='Your private trial';
  document.querySelector('.lead').textContent='Reserve a private space, then inspect and prepare your sample repository.';
  const root=document.getElementById('trial-state'),announcement=document.getElementById('trial-announcement');
  const narrow=matchMedia('(max-width:380px)');
  const verification=createTrialVerification({root,compact:()=>narrow.matches});
  const client=createTrialClient({notify:state=>{
    renderTrial(root,announcement,state,{...client,reserve:()=>client.reserve(verification.take())});
    verification.sync(state);
  }});
  narrow.addEventListener('change',()=>verification.sync(client.getState()));
  client.refresh();
  addEventListener('pagehide',()=>client.suspend());
  addEventListener('pageshow',event=>{if(event.persisted)client.refresh();});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)client.suspend();else client.refresh();
  });
}
