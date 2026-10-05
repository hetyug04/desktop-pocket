const sizes = bytes => { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let n = bytes, i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[i]}`; };
const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
const button = (text, fn, cls = '') => { const el = node('button', cls, text); el.type = 'button'; el.onclick = fn; return el; };
async function response(r) { const data = await r.json().catch(() => ({})); if (!r.ok) throw Error(data.error || (r.status === 401 ? 'Sign in again to use Files.' : 'Could not complete that. Try again.')); return data; }

const iconPaths = {
  upload: 'M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4',
  download: 'M12 4v12m-4-4 4 4 4-4M4 16v4h16v-4',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6',
  image: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 16l6-6 12 10M15 7h.01',
  text: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h6',
  media: 'M4 3h16v18H4ZM10 8l6 4-6 4Z',
  archive: 'M4 3h16v18H4ZM12 3v10m-2 0h4v4h-4Z',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 8h18',
  refresh: 'M20 7a9 9 0 1 0 1 7M20 3v5h-5',
  close: 'M6 6l12 12M6 18 18 6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  replace: 'M4 7h15l-4-4m4 4-4 4M20 17H5l4 4m-4-4 4-4',
  open: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  clipboard: 'M9 4H5v17h14V4h-4M9 2h6v4H9ZM8 11h8M8 15h5',
  copy: 'M8 8h13v13H8ZM16 8V3H3v13h5',
  paste: 'M9 4H5v17h14V4h-4M9 2h6v4H9ZM12 10v7m-3-3 3 3 3-3',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', iconPaths[name] || iconPaths.file); svg.append(path); return svg;
}
function withIcon(control, name) { control.prepend(icon(name)); return control; }
function fileKind(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (/^(png|jpg|jpeg|gif|webp|svg|heic|avif)$/.test(ext)) return 'image';
  if (/^(pdf|txt|md|docx?|xlsx?|csv|pptx?|json)$/.test(ext)) return 'text';
  if (/^(mp4|mov|mp3|m4a|wav|webm)$/.test(ext)) return 'media';
  if (/^(zip|gz|tar|7z|rar)$/.test(ext)) return 'archive';
  return 'file';
}
function fileDate(value) {
  const date = new Date(value), now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export function mount(el, app) {
  el.classList.add('files-pane');
  const wrap = node('div', 'files-wrap'), head = node('header', 'files-head');
  const heading = node('div', 'files-heading'); heading.append(node('h1', '', 'Files'), node('p', 'files-muted', 'Across your devices'));
  const picker = node('input', 'files-input'); picker.type = 'file'; picker.multiple = true; picker.setAttribute('aria-label', 'Choose files to upload');
  const replacementPicker = node('input', 'files-input'); replacementPicker.type = 'file'; replacementPicker.setAttribute('aria-label', 'Choose edited file to replace original');
  const choose = withIcon(button('Upload', () => picker.click(), 'files-primary'), 'upload');
  const refreshButton = withIcon(button('', () => { refresh(true); refreshClipboard(true); }, 'files-icon-button'), 'refresh'); refreshButton.setAttribute('aria-label', 'Refresh files and clipboard'); refreshButton.title = 'Refresh';
  const headActions = node('div', 'files-head-actions'); headActions.append(refreshButton, choose); head.append(heading, headActions);
  const layout = node('div', 'files-layout'), card = node('section', 'files-card files-folder');
  const folderHead = node('div', 'files-section-head'), folderTitle = node('div', 'files-folder-title');
  folderTitle.append(icon('folder'), node('h2', '', 'Shared folder'));
  const location = node('span', 'files-location', 'Connecting…'); location.setAttribute('role', 'status'); folderHead.append(folderTitle, location);
  const transfer = node('div', 'files-transfer'); transfer.hidden = true;
  const status = node('p', 'files-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const progress = node('progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', 'File upload progress');
  const cancel = button('Cancel', () => { cancelled = true; xhr?.abort(); }, 'files-secondary'); cancel.hidden = true;
  transfer.append(status, progress, cancel);
  const error = node('p', 'files-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const retry = button('Retry remaining files', run, 'files-secondary'); retry.hidden = true;
  const confirmBox = node('dialog', 'files-dialog files-confirm'); confirmBox.setAttribute('aria-labelledby', 'files-confirm-title');
  const confirmHeading = node('h2', '', 'Delete file?'); confirmHeading.id = 'files-confirm-title';
  const confirmText = node('p', 'files-muted'), confirmDelete = withIcon(button('Move to Trash', commitDelete, 'files-danger'), 'trash');
  const cancelDelete = button('Keep file', () => confirmBox.close(), 'files-secondary');
  const confirmError = node('p', 'files-error'); confirmError.setAttribute('role', 'alert'); confirmError.hidden = true;
  const confirmActions = node('div', 'files-confirm-actions'); confirmActions.append(cancelDelete, confirmDelete); confirmBox.append(confirmHeading, confirmText, confirmError, confirmActions);
  confirmBox.onclose = () => { deleting = null; if (!el.contains(document.activeElement) || document.activeElement === document.body) search.focus(); };
  confirmBox.oncancel = event => { if (busy) event.preventDefault(); };
  const undoBox = node('div', 'files-undo'); undoBox.hidden = true; const undoText = node('p'); undoText.setAttribute('role', 'status');
  const undoButton = button('Undo', restore, 'files-secondary'); undoBox.append(undoText, undoButton);
  const toolbar = node('div', 'files-toolbar'), searchBox = node('div', 'files-search-box'); searchBox.append(icon('search'));
  const search = node('input', 'files-search'); search.type = 'search'; search.placeholder = 'Search files'; search.setAttribute('aria-label', 'Search files'); searchBox.append(search);
  const sort = node('select', 'files-sort'); sort.setAttribute('aria-label', 'Sort files');
  for (const [value, label] of [['recent', 'Newest first'], ['name', 'Name A–Z'], ['size', 'Largest first']]) { const option = node('option', '', label); option.value = value; sort.append(option); }
  toolbar.append(searchBox, sort);
  const count = node('p', 'files-count files-muted'), list = node('ul', 'files-list'); list.setAttribute('aria-label', 'Shared files');
  const more = button('Show more files', () => { shown += 30; renderList(); }, 'files-secondary files-show-more'); more.hidden = true;
  const importButton = withIcon(button('Import from Taildrop', collect, 'files-secondary'), 'download');
  const footer = node('details', 'files-footer'), footerToggle = node('summary', '', 'Tailscale imports');
  footer.append(footerToggle, node('p', 'files-muted', 'Import files sent through Tailscale. Files in Downloads stay private until you upload them.'), importButton);
  card.append(folderHead, toolbar, transfer, error, retry, undoBox, count, list, more, footer);
  const clipCard = node('section', 'files-card files-clipboard'), clipHead = node('div', 'files-clip-head');
  clipHead.append(icon('clipboard'), node('h2', '', 'Clipboard')); clipCard.append(clipHead);
  clipCard.append(node('p', 'files-muted files-clip-hint', 'Paste here. Copy on another device.'));
  const draft = node('textarea', 'files-clip-text'); draft.rows = 2; draft.setAttribute('aria-label', 'Shared clipboard preview'); draft.placeholder = 'Nothing shared yet';
  const clipActions = node('div', 'files-clip-actions');
  const pasteButton = withIcon(button('Paste', pasteDevice), 'paste'), copyButton = withIcon(button('Copy', copyDevice), 'copy'); clipActions.append(pasteButton, copyButton);
  const clipStatus = node('p', 'files-muted files-clip-status'); clipStatus.setAttribute('role', 'status');
  const clipError = node('p', 'files-error'); clipError.setAttribute('role', 'alert'); clipError.hidden = true;
  clipCard.append(draft, clipActions, clipStatus, clipError);
  const actionSheet = node('dialog', 'files-dialog files-sheet'); actionSheet.setAttribute('aria-label', 'File actions');
  actionSheet.onclick = event => {
    if (event.target !== actionSheet) return;
    const bounds = actionSheet.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) actionSheet.close();
  };
  layout.append(card, clipCard); wrap.append(head, picker, replacementPicker, layout, actionSheet, confirmBox); el.replaceChildren(wrap);
  let clip = null, clipBusy = false, clipRefreshing = false, clipAvailable = false;
  let dirty = false, editVersion = null, editEpoch = 0, saveTimer = null, saving = null;
  let queue = [], recent = [], shown = 30, busy = false, ready = false, cancelled = false, xhr = null, replacement = null, deleting = null, lastDeleted = null, timer = null, visible = false, refreshing = false, snapshot = '';

  function clipboardError(message) { clipError.textContent = message; clipError.hidden = !message; }
  function clipControls() {
    pasteButton.disabled = clipBusy || busy || !clipAvailable;
    copyButton.disabled = clipBusy || !clipAvailable || !(dirty ? draft.value : clip?.text);
  }
  function displayClipboard(data) {
    clip = data; clipAvailable = true;
    if (!dirty && !saving) draft.value = data.text;
    if (!dirty && !saving) clipStatus.textContent = data.text ? 'Edit to update · clears after 10 minutes' : 'Paste to share across your devices';
    clipControls();
  }
  async function refreshClipboard(manual = false) {
    if (clipRefreshing || clipBusy || saving || dirty) return; clipRefreshing = true;
    try { displayClipboard(await response(await app.api('/api/files/clipboard'))); if (manual) clipboardError(''); }
    catch (e) { clipAvailable = false; clipStatus.textContent = 'Clipboard unavailable.'; if (manual) clipboardError(e.message); clipControls(); }
    finally { clipRefreshing = false; }
  }
  function edited() {
    if (!dirty) editVersion = clip?.version;
    dirty = true; editEpoch++; clipboardError(''); clipStatus.textContent = 'Saving…'; clipControls();
    clearTimeout(saveTimer); saveTimer = setTimeout(() => flushClipboard().catch(() => {}), 500);
  }
  async function flushClipboard() {
    clearTimeout(saveTimer);
    if (saving) { await saving; return flushClipboard(); }
    if (!dirty) return clip;
    if (!clipAvailable || !clip) { clipStatus.textContent = 'Not shared'; clipboardError('Clipboard unavailable. Your edit is still here.'); throw Error('Clipboard unavailable'); }
    const text = draft.value, epoch = editEpoch;
    if (new TextEncoder().encode(text).length > 256 * 1024) {
      clipboardError('Text is too large. Share a file instead (maximum 256 KB).'); throw Error('Text too large');
    }
    saving = (async () => {
      try {
        const data = await response(await app.api('/api/files/clipboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, version: editVersion }) }));
        clip = data; editVersion = data.version;
        if (epoch === editEpoch) dirty = false;
        clipStatus.textContent = dirty ? 'Saving…' : (text ? 'Edit to update · clears after 10 minutes' : 'Paste to share across your devices');
        return data;
      } catch (e) {
        clearTimeout(saveTimer); clipStatus.textContent = 'Not shared'; clipboardError(e.message + ' Your edit is still here.');
        // Preserve the draft; only a new deliberate edit retries against the fresh version.
        try { const current = await response(await app.api('/api/files/clipboard')); clip = current; editVersion = current.version; } catch {}
        throw e;
      }
    })();
    try { await saving; } finally { saving = null; clipControls(); }
    return dirty ? flushClipboard() : clip;
  }
  async function pasteDevice() {
    clipboardError('');
    if (!navigator.clipboard?.readText) { draft.focus(); clipboardError('Use the normal Paste action in the preview. It shares automatically.'); return; }
    // Read in the click gesture before network requests (Safari).
    const read = navigator.clipboard.readText(); clipBusy = true; clipControls();
    try {
      const text = await read; await flushClipboard();
      displayClipboard(await response(await app.api('/api/files/clipboard')));
      draft.value = text; edited(); await flushClipboard(); app.toast(text ? 'Pasted and shared' : 'Shared clipboard cleared');
    } catch (e) { draft.focus(); clipboardError(e.message || 'Use the normal Paste action in the preview.'); }
    finally { clipBusy = false; clipControls(); }
  }
  async function copyDevice() {
    clipboardError('');
    try {
      // Promised item preserves Safari activation while saving/fetching.
      const text = (async () => {
        await flushClipboard();
        const data = await response(await app.api('/api/files/clipboard')); displayClipboard(data);
        if (!data.text) throw Error('Clipboard is empty.');
        return new Blob([data.text], { type: 'text/plain' });
      })();
      text.catch(() => {});
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
      else if (navigator.clipboard?.writeText) {
        const write = navigator.clipboard.writeText(draft.value); await text; await write;
      } else { await text; throw Error('Clipboard access unavailable'); }
      app.toast('Copied. Paste in any app.');
    } catch { draft.focus(); draft.select(); clipboardError('Use the normal Copy action on the selected preview.'); }
  }
  draft.oninput = edited;
  draft.onpaste = event => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return; event.preventDefault();
    if (busy || !ready) { clipboardError('Wait for the shared folder to connect or finish uploading.'); return; }
    queue = files.map(file => ({ file, name: file.name || `pasted-${Date.now()}.png`, size: file.size })); run();
  };
  function showError(message) { error.textContent = message; error.hidden = !message; }
  function controls() {
    choose.disabled = busy || !ready; importButton.disabled = busy || !ready; retry.disabled = busy || !ready; refreshButton.disabled = busy;
    confirmDelete.disabled = busy; cancelDelete.disabled = busy; undoButton.disabled = busy || !ready;
    for (const b of list.querySelectorAll('button')) b.disabled = busy || !ready;
    retry.hidden = !queue.some(item => item.failed);
    cancel.hidden = !busy || !xhr; clipControls();
  }
  picker.onchange = () => {
    if (busy) return;
    queue = [...picker.files].map(file => ({ file, name: file.name, size: file.size })); picker.value = ''; showError(''); run();
  };
  replacementPicker.onchange = () => {
    if (busy || !replacement || !replacementPicker.files.length) return;
    const file = replacementPicker.files[0];
    queue = [{ file, name: replacement.name, size: file.size, replacing: replacement }]; replacementPicker.value = ''; replacement = null; showError(''); run();
  };
  search.oninput = () => { shown = 30; renderList(); };
  sort.onchange = () => { shown = 30; renderList(); };
  let dragDepth = 0;
  card.ondragenter = event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; card.classList.add('files-dragging'); } };
  card.ondragover = event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = ready && !busy ? 'copy' : 'none'; } };
  card.ondragleave = () => { if (--dragDepth <= 0) { dragDepth = 0; card.classList.remove('files-dragging'); } };
  card.ondrop = event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); dragDepth = 0; card.classList.remove('files-dragging');
    if (busy || !ready) { showError('Wait for the folder to connect or finish uploading.'); return; }
    queue = [...event.dataTransfer.files].map(file => ({ file, name: file.name, size: file.size })); run();
  };
  function askDelete(file) {
    actionSheet.close(); deleting = file; confirmError.hidden = true; confirmError.textContent = '';
    confirmText.textContent = `“${file.name}” will be removed from every device. You can undo this.`;
    confirmBox.showModal(); cancelDelete.focus();
  }
  function openActions(file) {
    actionSheet.replaceChildren();
    const top = node('div', 'files-sheet-head'), info = node('div', 'files-info');
    const name = node('h2', 'files-name', file.name); name.id = 'files-sheet-name'; actionSheet.setAttribute('aria-labelledby', name.id);
    info.append(name, node('p', 'files-muted', `${sizes(file.size)} · ${fileDate(file.modified)}`));
    const close = withIcon(button('', () => actionSheet.close(), 'files-icon-button'), 'close'); close.setAttribute('aria-label', 'Close file actions');
    top.append(info, close);
    const actions = node('div', 'files-sheet-actions'), url = `/api/files/download/${encodeURIComponent(file.id)}`;
    if (file.preview) { const open = withIcon(node('a', '', 'Open preview'), 'open'); open.href = `${url}?open=1`; open.target = '_blank'; open.rel = 'noopener'; open.onclick = () => actionSheet.close(); actions.append(open); }
    const download = withIcon(node('a', '', 'Download'), 'download'); download.href = url; download.download = file.name; download.onclick = () => actionSheet.close(); actions.append(download);
    actions.append(withIcon(button('Replace with edited file', () => { actionSheet.close(); replacement = file; replacementPicker.click(); }), 'replace'));
    actions.append(withIcon(button('Move to Trash', () => askDelete(file), 'files-danger'), 'trash'));
    actionSheet.append(top, actions); actionSheet.showModal();
  };

  function renderList() {
    list.replaceChildren(); const query = search.value.trim().toLocaleLowerCase(), filtered = recent.filter(f => f.name.toLocaleLowerCase().includes(query));
    if (sort.value === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    else if (sort.value === 'size') filtered.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
    count.textContent = `${filtered.length} file${filtered.length === 1 ? '' : 's'}${query ? ' found' : ''}`;
    toolbar.hidden = recent.length === 0; count.hidden = recent.length === 0;
    if (!filtered.length) {
      const empty = node('li', 'files-empty'); empty.append(icon(query ? 'search' : 'folder'), node('h3', '', query ? 'No files found' : 'Your shared space'), node('p', 'files-muted', query ? 'Try a different file name.' : 'Add a file here. Pick it up on any device.'));
      const action = query ? button('Clear search', () => { search.value = ''; renderList(); search.focus(); }, 'files-secondary') : withIcon(button('Upload files', () => picker.click(), 'files-secondary files-empty-upload'), 'upload');
      empty.append(action); list.append(empty);
    }
    for (const file of filtered.slice(0, shown)) {
      const item = node('li', 'files-file'), info = node('div', 'files-info'), kind = fileKind(file.name);
      const symbol = node('span', `files-type files-type-${kind}`); symbol.append(icon(kind));
      const url = `/api/files/download/${encodeURIComponent(file.id)}`;
      const name = node('a', 'files-name', file.name); name.href = file.preview ? `${url}?open=1` : url;
      if (file.preview) { name.target = '_blank'; name.rel = 'noopener'; name.setAttribute('aria-label', `Open ${file.name}`); }
      else { name.download = file.name; name.setAttribute('aria-label', `Download ${file.name}`); }
      const meta = node('span', 'files-muted files-meta', `${sizes(file.size)} · ${fileDate(file.modified)}`); meta.title = new Date(file.modified).toLocaleString();
      info.append(name, meta);
      const actions = node('div', 'files-row-actions');
      const download = withIcon(node('a', 'files-icon-button files-download', ''), 'download'); download.href = url; download.download = file.name; download.setAttribute('aria-label', `Download ${file.name}`); download.title = 'Download';
      const options = withIcon(button('', () => openActions(file), 'files-icon-button'), 'more'); options.setAttribute('aria-label', `More options for ${file.name}`); options.title = 'More options';
      actions.append(download, options); item.append(symbol, info, actions); list.append(item);
    }
    more.hidden = shown >= filtered.length; controls();
  }
  async function refresh(manual = false) {
    if (refreshing) return; refreshing = true;
    try {
      const data = await response(await app.api('/api/files/inbox'));
      if (!ready) showError(''); ready = true; location.textContent = 'Connected'; location.title = `Shared folder on ${data.machine}`; location.classList.remove('files-offline');
      const next = JSON.stringify(data.files);
      if (next !== snapshot || manual) { snapshot = next; recent = data.files; renderList(); }
      controls();
    } catch (e) { ready = false; location.textContent = 'Unavailable'; location.title = e.message; location.classList.add('files-offline'); showError(e.message); controls(); }
    finally { refreshing = false; }
  }
  function upload(item, index, total) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest(); xhr = request;
      request.open('POST', item.replacing ? `/api/files/replace/${encodeURIComponent(item.replacing.id)}` : '/api/files/upload');
      request.withCredentials = true; request.timeout = 30 * 60 * 1000;
      request.setRequestHeader('x-csrf-token', app.csrf()); request.setRequestHeader('content-type', 'application/octet-stream');
      request.setRequestHeader('x-file-name', encodeURIComponent(item.name)); request.setRequestHeader('x-file-size', String(item.size));
      if (item.replacing) request.setRequestHeader('x-file-version', item.replacing.version);
      request.upload.onprogress = e => {
        if (e.lengthComputable) progress.value = e.total ? e.loaded / e.total * 100 : 100;
        if (e.loaded === e.total) status.textContent = `${index}/${total} · ${item.name} · saving to shared folder…`;
      };
      request.onload = () => {
        let data; try { data = JSON.parse(request.responseText); } catch { data = {}; }
        if (request.status < 200 || request.status >= 300) reject(Error(data.error || 'Upload failed. Sign in again if your session expired.'));
        else resolve(data);
      };
      request.onerror = () => reject(Error('Connection lost. Check the shared folder before retrying.'));
      request.ontimeout = () => reject(Error('Upload timed out. Check the shared folder before retrying.'));
      request.onabort = () => reject(Error('Upload cancelled. If it had finished, the file may already be saved.'));
      request.onloadend = () => { if (xhr === request) xhr = null; controls(); };
      controls(); request.send(item.file);
    });
  }
  async function run() {
    if (busy || !ready || !queue.length) return;
    busy = true; cancelled = false; transfer.hidden = false; showError(''); controls();
    const batch = [...queue]; let completed = 0;
    try {
      for (const item of batch) {
        if (cancelled) break;
        progress.value = 0; status.textContent = `${completed + 1}/${batch.length} · ${item.replacing ? 'replacing' : 'uploading'} ${item.name}…`;
        try {
          const data = await upload(item, completed + 1, batch.length);
          progress.value = 100; completed++; queue = queue.filter(f => f !== item); status.textContent = `${data.file.name} · ${item.replacing ? 'replaced' : 'shared'}`;
        } catch (e) { item.failed = true; showError(e.message); break; }
      }
      if (completed) app.toast(`${completed} file${completed === 1 ? '' : 's'} saved to shared folder`);
    } finally { busy = false; cancel.hidden = true; transfer.hidden = !queue.length; controls(); await refresh(); }
  }
  async function commitDelete() {
    if (busy || !deleting) return; busy = true; showError(''); controls();
    try {
      const data = await response(await app.api(`/api/files/delete/${encodeURIComponent(deleting.id)}`, { method: 'POST', headers: { 'x-file-version': deleting.version } }));
      lastDeleted = data; undoText.textContent = `“${data.name}” moved to Trash.`; undoBox.hidden = false; confirmBox.close(); deleting = null; app.toast('File removed from shared folder');
    } catch (e) { confirmError.textContent = e.message; confirmError.hidden = false; }
    finally { busy = false; controls(); await refresh(); }
  }
  async function restore() {
    if (busy || !lastDeleted) return; busy = true; showError(''); controls();
    try {
      const data = await response(await app.api(`/api/files/restore/${lastDeleted.trashId}`, { method: 'POST' }));
      lastDeleted = null; undoBox.hidden = true; app.toast(`${data.file.name} restored`);
    } catch (e) { showError(e.message); }
    finally { busy = false; controls(); await refresh(); }
  }
  async function collect() {
    if (busy) return; busy = true; showError(''); controls();
    try { const data = await response(await app.api('/api/files/collect', { method: 'POST' })); app.toast(data.notice); }
    catch (e) { showError(e.message); }
    finally { busy = false; controls(); await refresh(); }
  }
  app.onShow(() => { visible = true; refresh(); refreshClipboard(); clearInterval(timer); timer = setInterval(() => { if (visible && !document.hidden) { if (!busy) refresh(); refreshClipboard(); } }, 5000); });
  app.onHide(() => { visible = false; clearInterval(timer); timer = null; actionSheet.close(); confirmBox.close(); });
  controls();
}
