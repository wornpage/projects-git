import {createTrialClient} from './client.js';
import {renderTrial} from './view.js';

if(location.pathname==='/trial/signup') {
  document.body.classList.add('signup-active');
  document.getElementById('trial-title').textContent='Your private trial';
  document.querySelector('.lead').textContent='Review what’s included, then reserve and manage a separate space.';
  const root=document.getElementById('trial-state'),announcement=document.getElementById('trial-announcement');
  const client=createTrialClient({notify:state=>renderTrial(root,announcement,state,client)});
  client.refresh();
  addEventListener('pagehide',()=>client.suspend());
  addEventListener('pageshow',event=>{if(event.persisted)client.refresh();});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)client.suspend();else client.refresh();
  });
}
