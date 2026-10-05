import RFB from '/novnc/core/rfb.js';
const $ = id => document.getElementById(id);
let rfb = null, csrf = '', connected = false, control = false, busy = false, fitted = true, pan = false, toastTimer, generation = 0;
function overlay(title,message){$('full-title').textContent=title;$('full-message').textContent=message;$('full-overlay').hidden=false;}
function toast(message){$('full-toast').textContent=message;$('full-toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('full-toast').hidden=true,5000);}
function controls(){
  $('full-take').disabled=!connected||busy;$('full-take').textContent=control?'Return control':'Take control';
  $('full-take').classList.toggle('controlling',control);$('full-mode').textContent=control?'You have control':'View only';
  $('full-keyboard').disabled=!connected||!control||busy;$('full-fit').disabled=!connected||busy;$('full-pan').disabled=!connected||fitted||busy;
  $('full-pan').setAttribute('aria-pressed',String(pan));$('full-fit').setAttribute('aria-pressed',String(fitted));$('full-fit').textContent=fitted?'Fit':'1:1';
  if(!control){$('full-keys').hidden=true;$('full-text').value='';}
  for(const el of document.querySelectorAll('[data-key],#full-send'))el.disabled=!control||!connected||busy;
}
async function api(url,body){
  const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  if(response.status===401){location.replace('/?full=1');throw Error('Sign in to continue.');}
  const data=await response.json();if(!response.ok)throw Error(data.error||'Connection failed.');return data;
}
async function disconnect(internal=false){
  if(!internal){generation++;busy=false;}
  const old=rfb;rfb=null;connected=false;control=false;controls();$('full-state').textContent='Disconnected';
  if(!old)return;
  await new Promise(resolve=>{let timer=setTimeout(resolve,2000);old.addEventListener('disconnect',()=>{clearTimeout(timer);resolve();},{once:true});old.disconnect();});
  if(!rfb)$('vnc-screen').replaceChildren();
}
function viewport(){if(!rfb)return;rfb.scaleViewport=fitted;rfb.clipViewport=!fitted;rfb.dragViewport=!fitted&&pan;controls();}
async function connect(wantControl=false){
  if(busy||document.hidden)return;const current=++generation;busy=true;controls();
  try{
    await disconnect(true);if(current!==generation||document.hidden)return;overlay('Connecting to your PC',wantControl?'Starting full-desktop control.':'Starting a read-only desktop connection.');
    const session=await api('/api/session');csrf=session.csrf;$('full-machine').textContent=session.machine;
    const ticket=await api('/api/full/connect',{control:wantControl});
    if(current!==generation||document.hidden)return;
    const client=new RFB($('vnc-screen'),`${location.protocol==='https:'?'wss':'ws'}://${location.host}/full-stream?ticket=${encodeURIComponent(ticket.ticket)}`,{shared:true,credentials:{password:ticket.password}});
    rfb=client;client.viewOnly=!wantControl;client.resizeSession=false;client.qualityLevel=Number($('full-quality').value);client.compressionLevel=2;viewport();
    client.addEventListener('connect',()=>{
      if(rfb!==client)return;connected=true;control=wantControl;busy=false;$('full-overlay').hidden=true;$('full-state').textContent='Live · full Windows desktop';controls();
      if(document.hidden)disconnect();
    });
    client.addEventListener('disconnect',event=>{
      if(rfb!==client)return;rfb=null;connected=false;control=false;busy=false;$('vnc-screen').replaceChildren();controls();$('full-state').textContent='Disconnected';
      overlay('Desktop disconnected',event.detail.clean?'Reconnect to view your PC. Control will not resume automatically.':'The connection closed. Check Tailscale and the desktop service, then reconnect.');
    });
    client.addEventListener('securityfailure',event=>{toast(event.detail.reason||'Desktop service authentication failed.');});
    client.addEventListener('credentialsrequired',()=>{client.disconnect();toast('Desktop service credentials need repair on the PC.');});
  }catch(error){if(current!==generation)return;busy=false;controls();$('full-state').textContent='Unavailable';overlay('Full desktop unavailable',error.message);}
}
$('full-take').addEventListener('click',()=>connect(!control));$('full-retry').addEventListener('click',()=>connect(false));
$('full-fit').addEventListener('click',()=>{fitted=!fitted;pan=!fitted;viewport();});
$('full-pan').addEventListener('click',()=>{pan=!pan;viewport();});
$('full-keyboard').addEventListener('click',()=>{if(!control)return;$('full-keys').hidden=!$('full-keys').hidden;if(!$('full-keys').hidden)$('full-text').focus();});
$('full-send').addEventListener('click',()=>{
  if(!control||!connected)return;const text=$('full-text').value;if(text.length>4096){toast('Send at most 4096 characters at a time.');return;}
  for(const char of text){const cp=char.codePointAt(0);rfb.sendKey(cp<=255?cp:0x01000000|cp,null);} $('full-text').value='';$('full-text').focus();
});
$('full-text').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('full-send').click();}});
const keys={enter:0xff0d,backspace:0xff08,tab:0xff09,esc:0xff1b,win:0xffeb,left:0xff51,up:0xff52,right:0xff53,down:0xff54};
for(const button of document.querySelectorAll('[data-key]'))button.addEventListener('click',()=>{
  if(!control||!connected)return;if(button.dataset.key==='alttab'){rfb.sendKey(0xffe9,'AltLeft',true);rfb.sendKey(0xff09,'Tab');rfb.sendKey(0xffe9,'AltLeft',false);}else rfb.sendKey(keys[button.dataset.key],null);
});
$('full-help').addEventListener('click',()=>$('full-settings').showModal());$('full-close').addEventListener('click',()=>$('full-settings').close());
$('full-expand').addEventListener('click',()=>{const expanded=document.querySelector('.full-app').classList.toggle('expanded');$('full-expand').textContent=expanded?'Exit':'Expand';$('full-expand').setAttribute('aria-pressed',String(expanded));});
$('full-quality').addEventListener('change',()=>{if(rfb)rfb.qualityLevel=Number($('full-quality').value);});
$('full-disconnect').addEventListener('click',async()=>{await disconnect();$('full-settings').close();overlay('Desktop disconnected','Reconnect when you want to view your PC.');});
$('full-logout').addEventListener('click',async()=>{await disconnect();await api('/api/logout',{});location.replace('/');});
document.addEventListener('visibilitychange',()=>{if(document.hidden){disconnect();}else if(!busy)connect(false);});
window.addEventListener('pagehide',()=>{rfb?.disconnect();});window.addEventListener('pageshow',event=>{if(event.persisted)connect(false);});
connect(false);
