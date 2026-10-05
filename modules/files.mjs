import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const TRANSFER_MS = 30 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });
function trimName(value, bytes = 180) { const chars = [...value]; while (Buffer.byteLength(chars.join('')) > bytes) chars.pop(); return chars.join(''); }
export function safeName(value) {
  let name = String(value || '').normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').replace(/^\.+/, '_');
  name = trimName(name).replace(/[. ]+$/g, '');
  if (!name.trim()) name = 'file';
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
const validName = name => typeof name === 'string' && name === safeName(name) && name !== '.' && name !== '..';
// Keep the old inbox IDs valid; never expose unrelated Downloads as shared storage.
const fileId = name => Buffer.from(JSON.stringify(['inbox', name])).toString('base64url');
function unpack(id) {
  try {
    if (!/^[\w-]{1,1200}$/.test(id)) throw Error();
    const [source, name] = JSON.parse(Buffer.from(id, 'base64url').toString());
    if (source !== 'inbox' || !validName(name)) throw Error();
    return name;
  } catch { throw fail(404, 'File not found.'); }
}
const revision = st => crypto.createHash('sha256').update(`${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`).digest('hex');
function disposition(name, mode) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`;
}
const previewTypes = new Map([['.pdf', 'application/pdf'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.txt', 'text/plain; charset=utf-8'], ['.md', 'text/plain; charset=utf-8'], ['.csv', 'text/plain; charset=utf-8'], ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4']]);

export default function register(api) {
  const base = api.dataDir('files'), inbox = path.join(base, 'inbox'), partial = path.join(base, 'partial'), trash = path.join(base, 'trash');
  const hostId = (process.env.DP_FILES_HOST || api.hostname).toLowerCase().replace(/\.$/, '');
  for (const dir of [inbox, partial, trash]) {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Files storage must be a real directory.');
  }
  let active = 0, collecting = null;
  const locks = new Map();
  let clipboard = { text: '', version: crypto.randomUUID(), updated: null, expires: null };
  const CLIP_LIMIT = 256 * 1024, CLIP_TTL = 10 * 60 * 1000;
  let clipboardTimer = null;
  function readClipboard() {
    if (clipboard.expires && Date.now() >= clipboard.expires) clipboard = { text: '', version: crypto.randomUUID(), updated: null, expires: null };
    return { ...clipboard };
  }
  async function setClipboard(req, res, ctx) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw fail(413, 'Clipboard text is too large (maximum 256 KB).'); chunks.push(chunk); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'Invalid clipboard request.'); }
    if (!data || typeof data.text !== 'string' || Buffer.byteLength(data.text) > CLIP_LIMIT) throw fail(413, 'Clipboard text is too large or invalid (maximum 256 KB).');
    await locked('shared-clipboard', async () => {
      const current = readClipboard();
      if (data.version !== current.version) throw fail(409, 'Clipboard changed on another device. Refresh it before sharing or clearing.');
      const now = Date.now();
      clipboard = { text: data.text, version: crypto.randomUUID(), updated: data.text ? now : null, expires: data.text ? now + CLIP_TTL : null };
      clearTimeout(clipboardTimer);
      if (data.text) {
        const version = clipboard.version;
        clipboardTimer = setTimeout(() => { if (clipboard.version === version) clipboard = { text: '', version: crypto.randomUUID(), updated: null, expires: null }; }, CLIP_TTL);
        clipboardTimer.unref?.();
      }
      ctx.json(200, readClipboard());
    });
  }
  const guarded = fn => async (req, res, ctx) => {
    try { await fn(req, res, ctx); }
    catch (e) {
      api.log('files', e.code || e.status || 'error', e.message);
      if (!res.headersSent && !res.destroyed) ctx.json(e.status || (e.code === 'ENOSPC' ? 507 : 500), { error: e.status ? e.message : e.code === 'ENOSPC' ? 'Storage is full. Free some space and retry.' : 'File operation failed. Check storage and try again.' });
      else if (!res.destroyed) res.destroy();
    }
  };
  const limited = fn => guarded(async (...args) => {
    if (active >= 4) throw fail(429, 'Four file operations are running. Try again shortly.');
    active++; try { await fn(...args); } finally { active--; }
  });
  async function locked(name, fn) {
    const previous = locks.get(name) || Promise.resolve();
    let release; const next = new Promise(resolve => { release = resolve; }); locks.set(name, next);
    await previous;
    try { return await fn(); } finally { release(); if (locks.get(name) === next) locks.delete(name); }
  }
  async function owner() {
    // Local reads should still work if Tailscale temporarily stops on the host.
    if (api.hostname.toLowerCase() === hostId) return { id: hostId, name: api.hostname, self: true, online: true, agent: true };
    let devices; try { devices = await api.peers(); } catch { throw fail(503, 'Cannot reach the shared folder. Check Tailscale.'); }
    const device = devices.find(d => d.id.toLowerCase() === hostId || d.dns?.toLowerCase() === hostId);
    if (!device || !device.online) throw fail(503, `Shared folder host ${hostId} is offline. No files are saved on this device instead.`);
    if (!device.self && (!device.agent || (device.agentInfo?.tabs && !device.agentInfo.tabs.includes('files')))) throw fail(503, 'The shared folder host needs the current Desktop Pocket Files module.');
    return device;
  }
  async function openFile(id) {
    const name = unpack(id), file = path.join(inbox, name);
    let handle;
    try {
      const realDir = await fsp.realpath(inbox), st = await fsp.lstat(file, { bigint: true });
      if (!st.isFile() || st.isSymbolicLink() || path.dirname(await fsp.realpath(file)) !== realDir) throw Error();
      handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const actual = await handle.stat({ bigint: true });
      if (!actual.isFile() || actual.ino !== st.ino || actual.dev !== st.dev) throw Error();
      return { handle, name, id: fileId(name), size: Number(actual.size), modified: new Date(Number(actual.mtimeMs)).toISOString(), version: revision(actual), preview: previewTypes.has(path.extname(name).toLowerCase()) };
    } catch { await handle?.close().catch(() => {}); throw fail(404, 'File not found. It may have been deleted.'); }
  }
  const describe = ({ handle, ...file }) => file;
  async function list() {
    const files = [], names = await fsp.readdir(inbox, { withFileTypes: true });
    for (let i = 0; i < names.length; i += 24) await Promise.all(names.slice(i, i + 24).map(async item => {
      if (!item.isFile() || !validName(item.name)) return;
      try { const file = await openFile(fileId(item.name)); files.push(describe(file)); await file.handle.close(); } catch {}
    }));
    files.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
    // All files are returned. The client renders small pages, so older files are not inaccessible.
    return { files, total: files.length, location: inbox, machine: api.hostname, sharedHost: hostId };
  }
  async function stage(req) {
    const declared = req.headers['x-file-size'];
    if (typeof declared !== 'string' || !/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw fail(400, 'A valid file size is required.');
    const expected = Number(declared), temp = path.join(partial, crypto.randomUUID() + '.part'); let bytes = 0;
    const counter = new Transform({ transform(chunk, enc, done) { bytes += chunk.length; done(bytes > expected ? fail(400, 'File is larger than its declared size.') : null, chunk); } });
    req.setTimeout?.(TRANSFER_MS);
    try {
      await pipeline(req, counter, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if (bytes !== expected) throw fail(400, 'Upload ended early. Please retry.');
      return temp;
    } catch (e) { await fsp.unlink(temp).catch(() => {}); throw e; }
  }
  async function publish(temp, name) {
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    for (let n = 0; n < 10000; n++) {
      const suffix = ` (${n})`, shortExt = trimName(ext, 80);
      const candidate = n ? `${trimName(stem, 180 - Buffer.byteLength(suffix + shortExt))}${suffix}${shortExt}` : name;
      try {
        await fsp.link(temp, path.join(inbox, candidate));
        // Removing the staging hard link changes ctime on NTFS. Return the final revision only.
        await fsp.unlink(temp);
        const file = await openFile(fileId(candidate)); const result = describe(file); await file.handle.close(); return result;
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw fail(409, 'Too many files with this name. Rename it and retry.');
  }
  async function receive(req, res, ctx) {
    let name; try { name = safeName(decodeURIComponent(req.headers['x-file-name'] || 'file')); } catch { throw fail(400, 'Invalid file name.'); }
    const temp = await stage(req);
    try { ctx.json(201, { file: await publish(temp, name), sharedHost: hostId }); }
    finally { await fsp.unlink(temp).catch(() => {}); }
  }
  async function requireVersion(id, expected) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw fail(428, 'Refresh the folder before changing this file.');
    const file = await openFile(id); await file.handle.close();
    if (file.version !== expected) throw fail(409, 'This file changed on another device. Refresh before replacing or deleting it.');
    return file;
  }
  async function replace(req, res, ctx) {
    const id = ctx.url.pathname.split('/').at(-1), name = unpack(id), version = req.headers['x-file-version'];
    await requireVersion(id, version); // Reject a known stale copy before uploading.
    const temp = await stage(req);
    try {
      await locked(name, async () => {
        await requireVersion(id, version); // Recheck after upload, under the same lock as delete/restore.
        await fsp.rename(temp, path.join(inbox, name));
        const file = await openFile(id); const result = describe(file); await file.handle.close(); ctx.json(200, { file: result });
      });
    } finally { await fsp.unlink(temp).catch(() => {}); }
  }
  async function remove(req, res, ctx) {
    const id = ctx.url.pathname.split('/').at(-1), name = unpack(id);
    await locked(name, async () => {
      await requireVersion(id, req.headers['x-file-version']);
      const trashId = crypto.randomUUID(), meta = path.join(trash, trashId + '.json');
      await fsp.writeFile(meta, JSON.stringify({ name, deleted: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      try { await fsp.rename(path.join(inbox, name), path.join(trash, trashId + '.bin')); }
      catch (e) { await fsp.unlink(meta).catch(() => {}); throw e; }
      ctx.json(200, { deleted: true, trashId, name });
    });
  }
  async function restore(req, res, ctx) {
    const id = ctx.url.pathname.split('/').at(-1);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw fail(404, 'Deleted file not found.');
    await locked('trash:' + id, async () => {
      const meta = path.join(trash, id + '.json'), data = path.join(trash, id + '.bin');
      let entry; try { entry = JSON.parse(await fsp.readFile(meta, 'utf8')); } catch { throw fail(404, 'Deleted file not found.'); }
      if (!validName(entry.name) || !(await fsp.lstat(data)).isFile() || (await fsp.lstat(data)).isSymbolicLink()) throw fail(404, 'Deleted file not found.');
      // publish() never overwrites a new file with the same name.
      const file = await publish(data, entry.name);
      await fsp.unlink(data).catch(e => { if (e.code !== 'ENOENT') throw e; }); await fsp.unlink(meta); ctx.json(200, { file });
    });
  }
  async function collect(req, res, ctx) {
    if (!collecting) collecting = api.tailscale(['file', 'get', '--conflict=rename', inbox], { timeout: 20000 }).finally(() => { collecting = null; });
    const result = await collecting;
    ctx.json(200, { ...(await list()), collected: result.code === 0, notice: result.code === 0 ? 'Pending Taildrop files imported. Files already saved in Downloads must be uploaded to share them.' : 'Taildrop could not be checked. You can still upload files directly.' });
  }
  async function download(req, res, ctx) {
    const file = await openFile(ctx.url.pathname.split('/').at(-1));
    try {
      const type = previewTypes.get(path.extname(file.name).toLowerCase()), inline = ctx.url.searchParams.get('open') === '1' && !!type;
      let start = 0, end = file.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return; }
        if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.size) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return; }
        status = 206;
      }
      res.writeHead(status, { 'Content-Type': inline ? type : 'application/octet-stream', 'Content-Disposition': disposition(file.name, inline ? 'inline' : 'attachment'), 'Content-Length': file.size ? end - start + 1 : 0, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", ETag: `"${file.version}"`, ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}) });
      if (!file.size) res.end(); else await pipeline(file.handle.createReadStream({ start, end, autoClose: false }), res);
    } finally { await file.handle.close().catch(() => {}); }
  }
  async function relay(req, res, device, route, binary = false) {
    const headers = {};
    for (const key of ['content-type', 'content-length', 'x-file-name', 'x-file-size', 'x-file-version', 'range']) if (req.headers[key]) headers[key] = req.headers[key];
    req.setTimeout?.(TRANSFER_MS);
    let r;
    try { r = await api.callPeer(device.dns, route, { method: req.method, headers, body: req.method === 'GET' ? undefined : req, timeout: TRANSFER_MS }); }
    catch { throw fail(503, 'Cannot reach the shared folder. Check the folder before retrying an upload.'); }
    if (binary && (r.ok || r.status === 416)) {
      const responseHeaders = {};
      for (const key of ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'etag', 'content-security-policy', 'x-content-type-options']) if (r.headers.get(key)) responseHeaders[key] = r.headers.get(key);
      res.writeHead(r.status, responseHeaders);
      const stream = r.body && Readable.fromWeb(r.body);
      if (!stream) { res.end(); return; }
      const timer = setTimeout(() => stream.destroy(Error('Download timed out.')), TRANSFER_MS); timer.unref?.();
      try { await pipeline(stream, res); } finally { clearTimeout(timer); }
    } else {
      // Bound metadata responses and their body deadline, independently of the shared hub timer.
      const stream = r.body && Readable.fromWeb(r.body), chunks = []; let size = 0;
      if (!stream) throw fail(502, 'Shared folder returned an empty reply.');
      const timer = setTimeout(() => stream.destroy(Error('Reply timed out.')), 30000); timer.unref?.();
      try { for await (const chunk of stream) { size += chunk.length; if (size > 16 * 1024 * 1024) throw fail(502, 'Shared folder listing is too large.'); chunks.push(chunk); } }
      finally { clearTimeout(timer); stream.destroy(); }
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(502, 'Shared folder returned an invalid reply.'); }
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers.get('content-range') ? { 'Content-Range': r.headers.get('content-range') } : {}) }); res.end(JSON.stringify(data));
    }
  }
  const shared = (local, agentPath, binary = false) => async (req, res, ctx) => {
    const device = await owner();
    if (device.self) await local(req, res, ctx);
    else await relay(req, res, device, agentPath(ctx.url), binary);
  };
  const suffix = url => '/' + url.pathname.split('/').at(-1) + url.search;
  api.tab({ id: 'files', title: 'Files', script: '/tabs/files.js', style: '/tabs/files.css', order: 30 });
  api.route('GET', '/api/files/clipboard', guarded(shared(async (req, res, ctx) => ctx.json(200, readClipboard()), () => '/api/agent/files/clipboard')));
  api.route('POST', '/api/files/clipboard', limited(shared(setClipboard, () => '/api/agent/files/clipboard')));
  api.route('GET', '/api/files/inbox', guarded(shared(async (req, res, ctx) => ctx.json(200, await list()), () => '/api/agent/files/inbox')));
  api.route('POST', '/api/files/upload', limited(shared(receive, () => '/api/agent/files/receive')));
  api.route('GET', '/api/files/download/*', guarded(shared(download, url => '/api/agent/files/download' + suffix(url), true)));
  api.route('POST', '/api/files/replace/*', limited(shared(replace, url => '/api/agent/files/replace' + suffix(url))));
  api.route('POST', '/api/files/delete/*', limited(shared(remove, url => '/api/agent/files/delete' + suffix(url))));
  api.route('POST', '/api/files/restore/*', limited(shared(restore, url => '/api/agent/files/restore' + suffix(url))));
  api.route('POST', '/api/files/collect', limited(shared(collect, () => '/api/agent/files/collect')));
  // Agent endpoints always operate on the destination's local folder, never recurse through owner().
  const agent = { auth: 'agent' };
  api.route('GET', '/api/agent/files/clipboard', guarded(async (req, res, ctx) => ctx.json(200, readClipboard())), agent);
  api.route('POST', '/api/agent/files/clipboard', limited(setClipboard), agent);
  api.route('GET', '/api/agent/files/inbox', guarded(async (req, res, ctx) => ctx.json(200, await list())), agent);
  api.route('POST', '/api/agent/files/receive', limited(receive), agent);
  api.route('GET', '/api/agent/files/download/*', guarded(download), agent);
  api.route('POST', '/api/agent/files/replace/*', limited(replace), agent);
  api.route('POST', '/api/agent/files/delete/*', limited(remove), agent);
  api.route('POST', '/api/agent/files/restore/*', limited(restore), agent);
  api.route('POST', '/api/agent/files/collect', limited(collect), agent);
}
