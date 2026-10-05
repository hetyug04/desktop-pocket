// QR generation is entirely local; enrollment secrets never go to a QR service.
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const qrOptions = {errorCorrectionLevel:'M', margin:4, width:360, color:{dark:'#000000',light:'#ffffff'}};
export const qrImage = text => QRCode.toDataURL(text, qrOptions);
export const terminalQr = text => QRCode.toString(text, {type:'terminal',small:true,errorCorrectionLevel:'M'});
export function appUrl(origin) {
  const url=new URL(origin);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid app origin');
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Phone links require HTTPS');
  return new URL('/',url.origin).href;
}
export function enrollmentUrl(origin, code, expires) {
  const url=new URL(appUrl(origin));
  if(!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)||!Number.isSafeInteger(expires)||expires<=Date.now())throw Error('Invalid enrollment link');
  url.hash=new URLSearchParams({setup:code,expires:String(expires)}).toString();
  return url.href;
}
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function phonePage({origin,code,expires,codes=[]}) {
  const link=code?enrollmentUrl(origin,code,expires):appUrl(origin);
  const qr=await qrImage(link);
  const ios='https://tailscale.com/download/ios';
  const android='https://tailscale.com/download/android';
  const recovery=codes.length ? `Desktop Pocket recovery codes\n\n${codes.join('\n')}\n\nEach works once to add a replacement passkey. Keep private and offline.\n` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Desktop Pocket — scan to connect</title><style>
  :root{color-scheme:dark;--ink:#f4f4f6;--muted:#b4bec7;--accent:#60cdff;--panel:#172028;--line:#35414b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#142b39,#070b10 70%);color:var(--ink);font:17px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:48px 24px}main{max-width:600px;margin:auto;text-align:center}h1{font-size:34px;line-height:1.15;margin:12px 0}p{color:var(--muted);margin:12px 0}.tag{text-transform:uppercase;letter-spacing:.15em;font-size:12px;color:var(--accent);font-weight:700}.card{margin-top:28px;padding:28px;border:1px solid var(--line);background:var(--panel);border-radius:24px}.qr{width:min(100%,320px);height:auto;aspect-ratio:1;background:white;border-radius:16px;display:block;margin:0 auto 20px}.url{display:block;color:var(--muted);font-size:14px;overflow-wrap:anywhere;user-select:text}a{color:var(--accent)}.button{display:inline-flex;min-height:48px;align-items:center;justify-content:center;padding:12px 20px;background:var(--accent);color:#00243a;border:0;border-radius:12px;text-decoration:none;font:inherit;font-weight:600;font-size:16px;line-height:1.4;cursor:pointer;margin:16px 4px 0}.button:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.secondary{background:#2b3945;color:var(--ink)}details{text-align:left;margin-top:20px;border-top:1px solid var(--line);padding-top:12px}summary{min-height:48px;cursor:pointer;display:flex;align-items:center;gap:12px;font-weight:600}summary:before{content:'+';color:var(--accent);font-size:22px}details[open] summary:before{content:'−'}.phone-options{display:grid;grid-template-columns:1fr 1fr;gap:20px;text-align:center}.phone-options img{width:min(100%,200px);height:auto;background:white;border-radius:12px}.phone-options p{font-size:15px}.small{font-size:14px}pre{white-space:pre-wrap;font:16px/1.7 ui-monospace,Consolas,monospace;user-select:text;color:var(--ink)}[hidden]{display:none!important}@media(max-width:420px){body{padding:28px 16px}.card{padding:20px}h1{font-size:28px}.phone-options{gap:12px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
  </style></head><body><main><span class="tag">Desktop Pocket</span><h1>${code?'Scan. Tap. You’re in.':'Your PC, one scan away.'}</h1><p>${code?'Point your phone’s camera at the QR code. No address or setup code to type.':'Point your phone’s camera at the QR code to open Desktop Pocket.'}</p><section class="card"><img id="main-qr" class="qr" src="${qr}" alt="${code?'Scan to open passkey setup':'Scan to open Desktop Pocket'}"><strong id="scan-status">${code?'Then tap Create passkey and confirm with Face ID.':'Sign in with your passkey.'}</strong><p class="small">Tailscale must be connected on your phone to your own account.</p>${code?'<p id="expiry" class="small"></p>':''}<span class="url">${escape(appUrl(origin))}</span><a id="open-link" class="button secondary" href="${escape(link)}">${code?'Set up on this PC':'Open on this PC'}</a><details><summary>Need Tailscale on your phone?</summary><div class="phone-options"><div><p>iPhone</p><img src="${await qrImage(ios)}" alt="Scan to get Tailscale for iPhone"><p><a href="${ios}">Get Tailscale for iPhone</a></p></div><div><p>Android</p><img src="${await qrImage(android)}" alt="Scan to get Tailscale for Android"><p><a href="${android}">Get Tailscale for Android</a></p></div></div><p class="small">Install and sign in to the same Tailscale account as this PC. Then scan the large QR code above.</p></details>${recovery?`<details><summary>Save your recovery kit</summary><p class="small">Save these once-use codes in your password manager or somewhere safe offline. They replace a lost passkey.</p><a class="button" download="DesktopPocket-recovery.txt" href="data:text/plain;charset=utf-8,${encodeURIComponent(recovery)}">Save recovery kit</a><button class="button secondary" id="copy-recovery" type="button">Copy codes</button><pre id="recovery-codes">${escape(codes.join('\n'))}</pre><p id="copy-status" role="status" class="small"></p></details>`:''}${code?`<details><summary>Camera not available?</summary><p class="small">Open the address above, choose Set up this device, and use this fallback code:</p><pre>${escape(code)}</pre></details>`:''}</section><p class="small">${code?'Private setup QR · valid for 15 minutes · do not share it. Close this page when finished.':'Tailnet-only access · your PC needs to stay awake.'}</p></main><script>
  const expires=${code?expires:0};if(expires){const update=()=>{const seconds=Math.max(0,Math.ceil((expires-Date.now())/1000));document.getElementById('expiry').textContent=seconds?'Expires in '+Math.ceil(seconds/60)+' minute'+(seconds>60?'s':'')+'.':'This QR expired. Run SECURITY-SETUP.cmd for a fresh one.';if(!seconds){document.getElementById('main-qr').hidden=true;document.getElementById('open-link').hidden=true;document.getElementById('scan-status').textContent='Setup QR expired';}};update();setInterval(update,1000);}
  const copy=document.getElementById('copy-recovery');if(copy)copy.onclick=async()=>{const text=document.getElementById('recovery-codes').textContent;try{await navigator.clipboard.writeText(text);document.getElementById('copy-status').textContent='Copied. Save in your password manager.';}catch{const range=document.createRange();range.selectNodeContents(document.getElementById('recovery-codes'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.getElementById('copy-status').textContent='Codes selected. Copy or use Save recovery kit.';}};
  </script></body></html>`;
}
// Secret-bearing pages are local files outside the served public/ directory, with a private Windows ACL.
export function writePhonePage(file, html, {privatePage=false}={}) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(!privatePage){fs.writeFileSync(file,html);return;}
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,'',{mode:0o600});
  try {
    if(process.platform==='win32') {
      const who=spawnSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
      const sid=who.stdout?.match(/S-1-5-[0-9-]+/)?.[0];
      if(who.status!==0||!sid)throw Error('Cannot identify the Windows owner for the private QR page');
      const acl=spawnSync('icacls.exe',[tmp,'/inheritance:r','/grant:r',`*${sid}:(F)`,'*S-1-5-18:(F)','*S-1-5-32-544:(F)'],{windowsHide:true,stdio:'ignore'});
      if(acl.status!==0)throw Error('Cannot protect the private QR page');
    }
    fs.writeFileSync(tmp,html,{mode:0o600});fs.renameSync(tmp,file);
  } finally {fs.rmSync(tmp,{force:true});}
}
