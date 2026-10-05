import {appUrl,terminalQr,phonePage,writePhonePage} from './phone-qr.mjs';
const [origin,file]=process.argv.slice(2);
const link=appUrl(origin);
console.log('\nScan with your phone camera to open Desktop Pocket:\n');
console.log(await terminalQr(link));
console.log('Tailscale must be on. Sign in with your passkey.');
if(file)writePhonePage(file,await phonePage({origin}));
