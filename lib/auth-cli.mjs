// security-setup: run on one of your computers (needs that computer's login, not the network).
//
//   node lib/auth-cli.mjs setup            a one-time code to add passkeys (15 minutes, up to 5 devices);
//                                          also makes recovery codes the first time
//   node lib/auth-cli.mjs recovery         new recovery codes (the old ones stop working)
//   node lib/auth-cli.mjs status           passkeys and recovery codes left
//   node lib/auth-cli.mjs signout-all      sign every device out on every computer
//
// The passkey list and recovery codes are shared by every computer running Desktop Pocket.
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {enrollmentUrl,terminalQr,phonePage,writePhonePage} from './phone-qr.mjs';
import { readStore, writeStore, storePath, makeCode, hashCode } from './auth.mjs';

const passwordFile = process.env.DESKTOP_PASSWORD_FILE || path.join(os.homedir(), '.opencode-remote', 'password.txt');
const file = storePath(passwordFile);
const cmd = process.argv[2] || 'setup';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let saved = {}; try { saved = JSON.parse(fs.readFileSync(path.join(root,'run','config.json'),'utf8')); } catch {}
const origin = process.env.DESKTOP_ORIGIN || saved.origin;
const qrArg = process.argv.indexOf('--qr-file');
const qrFile = qrArg >= 0 ? process.argv[qrArg + 1] : null;
const bold = s => `\x1b[1m${s}\x1b[0m`, dim = s => `\x1b[2m${s}\x1b[0m`;

function newRecovery(s) {
  const codes = Array.from({ length: 10 }, () => makeCode(3, 4));
  s.recovery = { id: crypto.randomBytes(8).toString('base64url'), rev: (s.recovery?.rev || 0) + 1, created: Date.now(), codes: codes.map(c => hashCode(c)) };
  return codes;
}
function printRecovery(codes) {
  console.log('');
  console.log(bold('Recovery codes') + ' (each works once, only to add a new passkey if you lose your devices)');
  for (let i = 0; i < codes.length; i += 2) console.log(`   ${codes[i]}     ${codes[i + 1] || ''}`);
  console.log(dim('   Save them somewhere safe and offline (a password manager, or on paper). They won’t be shown again.'));
}

const s = readStore(file);
if (!s.user.created) s.user.created = Date.now();
const active = s.credentials.filter(c => !c.removed);
const left = s.recovery.codes.filter(c => !c.used).length;

if (cmd === 'setup') {
  const code = makeCode(2, 4);
  s.enroll = { ...hashCode(code), expires: Date.now() + 15 * 60000, uses: 0, created: Date.now() };
  const fresh = left === 0 || process.argv.includes('--new-recovery');
  const codes = fresh ? newRecovery(s) : null;
  s.updated = Date.now(); writeStore(file, s);
  console.log('');
  console.log(bold('Passkey setup code:  ') + `\x1b[1;36m${code}\x1b[0m` + dim('   (good for 15 minutes, up to 5 devices)'));
  console.log('');
  if (origin) {
    console.log(bold('Scan with your phone camera — no code to type:'));
    console.log(await terminalQr(enrollmentUrl(origin, code, s.enroll.expires)));
    console.log('  Tap Create passkey, then confirm with Face ID / Touch ID / Windows Hello.');
    if (qrFile) {
      writePhonePage(qrFile, await phonePage({origin,code,expires:s.enroll.expires,codes:codes || []}), {privatePage:true});
      console.log(dim('  A private scan-to-set-up page is ready on this PC.'));
    }
  } else {
    console.log('Start Desktop Pocket first for a scan-to-set-up QR, or enter the fallback code above in Set up this device.');
  }
  console.log(dim('  Your iPhone passkey also appears on your Mac through iCloud Keychain.'));
  if (codes) printRecovery(codes);
  else console.log('\n' + dim(`You still have ${left} recovery code${left === 1 ? '' : 's'}. New ones: security-setup recovery`));
  console.log('');
} else if (cmd === 'recovery') {
  const codes = newRecovery(s); s.updated = Date.now(); writeStore(file, s);
  printRecovery(codes); console.log(dim('\nThe old recovery codes no longer work.\n'));
  if (origin && qrFile) writePhonePage(qrFile, await phonePage({origin,codes}), {privatePage:true});
} else if (cmd === 'signout-all') {
  s.epoch = Date.now(); s.updated = Date.now(); writeStore(file, s);
  console.log('Every device is signed out on every computer. Sign in again with your passkey.');
} else {
  console.log(`\n${bold('Passkeys')} (${active.length})`);
  for (const c of active) console.log(`   ${c.name}  ${dim('added ' + new Date(c.created).toLocaleDateString() + (c.lastUsed ? ', last used ' + new Date(c.lastUsed).toLocaleString() : ''))}`);
  if (!active.length) console.log('   none yet: run security-setup');
  console.log(`${bold('Recovery codes left:')} ${left} of ${s.recovery.codes.length}`);
  console.log(dim(`Stored in ${file}\n`));
}
