import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import register, { safeName } from '../modules/files.mjs';
import { createHub } from '../lib/hub.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const origin = 'http://127.0.0.1:4098', session = { csrf: 'files-test-csrf' };
const auth = { cookie: 'test=session', origin, 'x-csrf-token': session.csrf };
const HOST = 'test-host';

test('Shared Files folder through two real hubs on port 4098', async t => {
  const parent = path.join(root, 'run', 'files'); await fsp.mkdir(parent, { recursive: true });
  const fixture = await fsp.mkdtemp(path.join(parent, 'test-shared-'));
  const previousHost = process.env.DP_FILES_HOST; process.env.DP_FILES_HOST = HOST;
  const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
  // Signatures now name the machine they're for (Claude's security update): map the test host to this server.
  process.env.DP_PEER_URLS = JSON.stringify({ 'test-host.test.ts.net': origin });
  const makeHub = name => {
    const hub = createHub({ root, password: 'files-shared-test-password', publicOrigin: origin, hosts: new Set(['127.0.0.1:4098']), origins: new Set([origin]), sessionFor: req => req.headers.cookie === auth.cookie ? session : null, json });
    hub.api.hostname = name;
    hub.api.dataDir = () => { const dir = path.join(fixture, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
    hub.api.log = () => {};
    return hub;
  };
  const host = makeHub(HOST), mac = makeHub('test-mac'), commands = [];
  let online = true;
  mac.api.peers = async () => [{ id: HOST, name: HOST, dns: 'test-host.test.ts.net', online, agent: true, self: false, agentInfo: { tabs: ['files'] } }, { id: 'test-mac', name: 'Test Mac', dns: 'mac.test.ts.net', online: true, agent: true, self: true }];
  mac.api.callPeer = async (dns, route, options) => {
    assert.equal(dns, 'test-host.test.ts.net');
    return fetch(origin + route, { method: options.method, body: options.body, ...(options.body ? { duplex: 'half' } : {}), headers: { ...options.headers, ...mac.api.agentHeaders(options.method, route.split('?')[0], dns) } });
  };
  host.api.tailscale = async (args, options) => { commands.push({ args, options }); return { code: 0, stdout: '', stderr: '' }; };
  mac.api.tailscale = async () => { throw Error('Taildrop must run only on shared host'); };
  register(host.api); register(mac.api);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin), isMac = url.pathname.startsWith('/mac/');
    if (isMac) url.pathname = url.pathname.slice(4);
    if (!await (isMac ? mac : host).handleRequest(req, res, url)) json(res, 404, { error: 'Not found' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4098, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fsp.rm(fixture, { recursive: true, force: true });
    if (previousHost === undefined) delete process.env.DP_FILES_HOST; else process.env.DP_FILES_HOST = previousHost;
  });
  const get = (route, headers = {}) => fetch(origin + route, { headers: { ...auth, ...headers } });
  const post = (route, body, headers = {}) => fetch(origin + route, { method: 'POST', headers: { ...auth, ...headers }, body, ...(body instanceof Readable ? { duplex: 'half' } : {}) });
  const upload = (name, body, prefix = '') => post(prefix + '/api/files/upload', body, { 'x-file-name': encodeURIComponent(name), 'x-file-size': String(Buffer.byteLength(body)) });
  const replace = (file, body, prefix = '', version = file.version) => post(prefix + '/api/files/replace/' + file.id, body, { 'x-file-size': String(Buffer.byteLength(body)), 'x-file-version': version });
  const remove = (file, prefix = '') => post(prefix + '/api/files/delete/' + file.id, undefined, { 'x-file-version': file.version });
  const list = async (prefix = '') => (await get(prefix + '/api/files/inbox')).json();
  let original;

  await t.test('sessions, CSRF, origin, agent auth and replay protection apply to every mutation', async () => {
    assert.equal(host.tabs()[0].id, 'files');
    assert.equal((await fetch(origin + '/api/files/inbox')).status, 401);
    assert.equal((await post('/api/files/collect', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/files/delete/anything', undefined, { 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await get('/api/agent/files/inbox')).status, 401);
    assert.equal((await post('/api/agent/files/receive', 'abc')).status, 401);
    const signature = host.api.agentHeaders('POST', '/api/agent/files/receive', 'test-host.test.ts.net');
    const headers = { ...signature, 'x-file-name': 'agent.txt', 'x-file-size': '3' };
    assert.equal((await post('/api/agent/files/receive', 'abc', headers)).status, 201);
    assert.equal((await post('/api/agent/files/receive', 'abc', headers)).status, 401);
  });
  await t.test('clipboard text is shared across devices without disk persistence', async () => {
    assert.equal((await fetch(origin + '/api/files/clipboard')).status, 401);
    assert.equal((await get('/api/agent/files/clipboard')).status, 401);
    const initial = await (await get('/api/files/clipboard')).json();
    const text = 'Desktop Pocket clipboard test 🌍\nsecond line <script>not HTML</script>';
    const saved = await post('/mac/api/files/clipboard', JSON.stringify({ text, version: initial.version }));
    assert.equal(saved.status, 200); const value = await saved.json(); assert.equal(value.text, text);
    assert.deepEqual(await (await get('/api/files/clipboard')).json(), await (await get('/mac/api/files/clipboard')).json());
    assert.equal(value.expires - value.updated, 600000);
    assert.equal(fs.readdirSync(path.join(fixture, HOST)).some(n => /clipboard/.test(n)), false);
    assert.equal((await post('/api/files/clipboard', JSON.stringify({ text: '', version: initial.version }))).status, 409);
    const cleared = await post('/mac/api/files/clipboard', JSON.stringify({ text: '', version: value.version }));
    assert.equal(cleared.status, 200); assert.equal((await cleared.json()).text, '');
  });
  await t.test('clipboard mutations enforce origin, CSRF, bounds and concurrent version checks', async () => {
    const current = await (await get('/api/files/clipboard')).json();
    const body = JSON.stringify({ text: 'test', version: current.version });
    assert.equal((await post('/api/files/clipboard', body, { 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await post('/api/files/clipboard', body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/files/clipboard', '{bad')).status, 400);
    assert.equal((await post('/api/files/clipboard', JSON.stringify({ text: 'x'.repeat(262145), version: current.version }))).status, 413);
    const concurrent = await Promise.all([post('/api/files/clipboard', body), post('/mac/api/files/clipboard', body)]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  });
  await t.test('clipboard expires after ten minutes and has no offline local fallback', async () => {
    const current = await (await get('/api/files/clipboard')).json();
    const now = Date.now;
    Date.now = () => current.expires + 1;
    try { const expired = await (await get('/mac/api/files/clipboard')).json(); assert.equal(expired.text, ''); assert.equal(expired.expires, null); assert.notEqual(expired.version, current.version); }
    finally { Date.now = now; }
    online = false;
    try { assert.equal((await get('/mac/api/files/clipboard')).status, 503); }
    finally { online = true; }
  });
  await t.test('portable names, invalid sizes and file IDs cannot escape shared storage', async () => {
    for (const name of ['../a.txt', '..\\a.txt', 'C:\\outside', 'CON.txt', 'nul', 'LPT1.log', 'com¹.txt', 'a:b', '..']) {
      const clean = safeName(name); assert.ok(!/[\\/:\x00]/.test(clean)); assert.equal(safeName(clean), clean);
    }
    const r = await upload('../CON.txt', 'safe'); assert.equal(r.status, 201); assert.equal((await r.json()).file.name, safeName('../CON.txt'));
    assert.equal((await post('/api/files/upload', 'x', { 'x-file-size': '-1' })).status, 400);
    for (const [source, name] of [['inbox', '../password.txt'], ['downloads', 'private.txt']]) {
      const id = Buffer.from(JSON.stringify([source, name])).toString('base64url');
      assert.equal((await get('/api/files/download/' + id)).status, 404);
      assert.equal((await post('/api/files/delete/' + id)).status, 404);
    }
  });
  await t.test('uploading through the Mac produces the exact same shared listing on both devices', async () => {
    const r = await upload('shared.txt', 'one canonical copy', '/mac'); assert.equal(r.status, 201); original = (await r.json()).file;
    assert.equal(fs.readFileSync(path.join(fixture, HOST, 'inbox', original.name), 'utf8'), 'one canonical copy');
    assert.deepEqual(fs.readdirSync(path.join(fixture, 'test-mac', 'inbox')), []);
    const a = await list(), b = await list('/mac'); assert.deepEqual(a.files, b.files); assert.equal(b.machine, HOST);
    assert.equal(await (await get('/mac/api/files/download/' + original.id)).text(), 'one canonical copy');
    assert.equal(a.files.every(f => !f.source || f.source === 'inbox'), true);
  });
  await t.test('concurrent same-name uploads preserve all copies', async () => {
    const duplicates = await Promise.all([upload('shared.txt', 'a'), upload('shared.txt', 'b', '/mac')]);
    const files = await Promise.all(duplicates.map(async r => (await r.json()).file));
    assert.deepEqual(files.map(f => f.name).sort(), ['shared (1).txt', 'shared (2).txt']);
    assert.equal(await (await get('/api/files/download/' + original.id)).text(), 'one canonical copy');
  });
  await t.test('replacement keeps the filename/ID and rejects stale or missing versions', async () => {
    assert.equal((await replace(original, 'missing version', '', '')).status, 428);
    const r = await replace(original, 'edited on Mac', '/mac'); assert.equal(r.status, 200);
    const updated = (await r.json()).file; assert.equal(updated.id, original.id); assert.equal(updated.name, original.name); assert.notEqual(updated.version, original.version);
    assert.equal((await replace(original, 'stale overwrite')).status, 409);
    assert.equal((await remove(original)).status, 409);
    assert.equal(await (await get('/api/files/download/' + original.id)).text(), 'edited on Mac'); original = updated;
  });
  await t.test('two concurrent replacements cannot silently overwrite each other', async () => {
    const results = await Promise.all([replace(original, 'edit A'), replace(original, 'edit B', '/mac')]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    original = (await list()).files.find(f => f.id === original.id);
  });
  await t.test('delete is global and recoverable; restore never overwrites a later upload', async () => {
    const r = await remove(original, '/mac'); assert.equal(r.status, 200); const deleted = await r.json();
    assert.equal((await list()).files.some(f => f.id === original.id), false);
    assert.equal((await list('/mac')).files.some(f => f.id === original.id), false);
    assert.equal((await get('/api/files/download/' + original.id)).status, 404);
    const newer = (await (await upload(original.name, 'new file')).json()).file;
    const restored = await post('/mac/api/files/restore/' + deleted.trashId); assert.equal(restored.status, 200);
    const restoredFile = (await restored.json()).file; assert.notEqual(restoredFile.name, newer.name);
    assert.equal(await (await get('/api/files/download/' + newer.id)).text(), 'new file');
    assert.equal((await post('/api/files/restore/' + deleted.trashId)).status, 404);
    assert.equal((await post('/api/files/restore/../../outside')).status, 404);
  });
  await t.test('host offline never silently switches to a local shared folder', async () => {
    online = false;
    assert.equal((await get('/mac/api/files/inbox')).status, 503);
    assert.equal((await upload('offline.txt', 'do not save', '/mac')).status, 503);
    assert.deepEqual(fs.readdirSync(path.join(fixture, 'test-mac', 'inbox')), []); online = true;
  });
  await t.test('downloads support ranges and safe previews through either host', async () => {
    const file = (await (await upload('range.txt', 'hello files')).json()).file;
    const ranged = await get('/mac/api/files/download/' + file.id, { range: 'bytes=1-4' }); assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'ello');
    const suffix = await get('/api/files/download/' + file.id, { range: 'bytes=-5' }); assert.equal(await suffix.text(), 'files');
    assert.equal((await get('/api/files/download/' + file.id, { range: 'bytes=999-' })).status, 416);
    assert.equal((await get('/mac/api/files/download/' + file.id, { range: 'bytes=999-' })).status, 416);
    const preview = await get('/mac/api/files/download/' + file.id + '?open=1'); assert.match(preview.headers.get('content-type'), /text\/plain/); assert.match(preview.headers.get('content-security-policy'), /sandbox/);
    const html = (await (await upload('unsafe.html', '<script>alert(1)</script>')).json()).file;
    assert.match((await get('/mac/api/files/download/' + html.id + '?open=1')).headers.get('content-disposition'), /^attachment/);
    const empty = (await (await upload('empty.txt', '')).json()).file; assert.equal(await (await get('/mac/api/files/download/' + empty.id)).text(), '');
  });
  await t.test('Taildrop import runs only on the canonical host', async () => {
    const r = await post('/mac/api/files/collect'); assert.equal(r.status, 200); assert.equal((await r.json()).collected, true);
    assert.deepEqual(commands.at(-1).args, ['file', 'get', '--conflict=rename', path.join(fixture, HOST, 'inbox')]);
  });
  await t.test('long Unicode names and collisions remain downloadable', async () => {
    const name = '🌍'.repeat(100) + '.txt', a = (await (await upload(name, 'a')).json()).file, b = (await (await upload(name, 'b', '/mac')).json()).file;
    assert.notEqual(a.name, b.name); assert.ok(Buffer.byteLength(a.name) <= 180); assert.ok(Buffer.byteLength(b.name) <= 180);
    assert.equal(await (await get('/mac/api/files/download/' + b.id)).text(), 'b');
  });
  await t.test('a 1 GiB upload relays with backpressure to the host, never a second local copy', async () => {
    const block = Buffer.alloc(256 * 1024, 0x61), blocks = 4096, expected = crypto.createHash('sha256');
    async function* source() { for (let n = 0; n < blocks; n++) { expected.update(block); if (n === 128) assert.equal(fs.existsSync(path.join(fixture, HOST, 'inbox', 'large.bin')), false); yield block; } }
    const r = await post('/mac/api/files/upload', Readable.from(source()), { 'x-file-name': 'large.bin', 'x-file-size': String(block.length * blocks) });
    assert.equal(r.status, 201); const file = (await r.json()).file; assert.equal(file.size, 1024 * 1024 * 1024);
    const actual = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(path.join(fixture, HOST, 'inbox', file.name))) actual.update(chunk);
    assert.equal(actual.digest('hex'), expected.digest('hex')); assert.deepEqual(fs.readdirSync(path.join(fixture, 'test-mac', 'inbox')), []);
  });
  await t.test('incomplete uploads and replacements never expose partial data', async () => {
    await post('/api/files/upload', 'short', { 'x-file-name': 'broken.bin', 'x-file-size': '1000' }).catch(() => null);
    assert.equal(fs.existsSync(path.join(fixture, HOST, 'inbox', 'broken.bin')), false);
    const file = (await (await upload('intact.txt', 'original')).json()).file;
    await post('/api/files/replace/' + file.id, 'short', { 'x-file-size': '1000', 'x-file-version': file.version }).catch(() => null);
    assert.equal(await (await get('/api/files/download/' + file.id)).text(), 'original');
    assert.deepEqual(fs.readdirSync(path.join(fixture, HOST, 'partial')), []);
  });
});
