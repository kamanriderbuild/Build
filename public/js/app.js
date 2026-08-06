const PARTS = [
  '前机盖', '前保险杠', '左前大灯', '右前大灯', '左前叶子板', '右前叶子板',
  '左前门', '右前门', '左后叶子板', '右后叶子板', '后尾盖', '备胎槽',
  '左后尾灯', '右后尾灯', '左A柱', '右A柱', '左B柱', '右B柱', '左C柱', '右C柱',
  '左下裙边', '右下裙边', '座椅', '顶蓬'
];

const DB_NAME = 'chezi-inspection';
const DB_VERSION = 1;

const state = {
  view: 'home',
  records: [],
  current: null,
  currentPart: null,
  deferredInstall: null,
  objectUrls: []
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function emptyPartsMeta() {
  return Object.fromEntries(PARTS.map((p) => [p, { description: '', photos: [] }]));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        db.createObjectStore('records', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('byRecord', 'recordId', { unique: false });
        store.createIndex('byRecordPart', ['recordId', 'part'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开本地数据库'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('本地存储失败'));
    tx.onabort = () => reject(tx.error || new Error('本地存储已中断'));
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('本地读取失败'));
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await fn(store, tx);
  await txDone(tx);
  return result;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

function showView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function revokeObjectUrls() {
  state.objectUrls.forEach((u) => URL.revokeObjectURL(u));
  state.objectUrls = [];
}

function blobUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);
  return url;
}

function photoCounts(record) {
  const counts = {};
  let total = 0;
  PARTS.forEach((p) => {
    const n = (record.parts?.[p]?.photos || []).length;
    counts[p] = n;
    total += n;
  });
  return { counts, total };
}

async function listRecords() {
  const rows = await withStore('records', 'readonly', (store) => reqDone(store.getAll()));
  return (rows || [])
    .map((r) => {
      const { counts, total } = photoCounts(r);
      return { ...r, photoCounts: counts, photoTotal: total };
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function getRecord(id) {
  const record = await withStore('records', 'readonly', (store) => reqDone(store.get(id)));
  if (!record) throw new Error('记录不存在');
  const { counts, total } = photoCounts(record);
  return { ...record, photoCounts: counts, photoTotal: total, parts: PARTS };
}

async function createRecord({ plate = '', title = '', note = '' }) {
  const now = new Date().toISOString();
  const record = {
    id: uid(),
    plate: String(plate).trim(),
    title: String(title).trim() || (plate ? `${String(plate).trim()} 验车` : '未命名验车'),
    note: String(note).trim(),
    createdAt: now,
    updatedAt: now,
    parts: emptyPartsMeta()
  };
  await withStore('records', 'readwrite', (store) => {
    store.put(record);
  });
  return record;
}

async function saveRecord(record) {
  record.updatedAt = new Date().toISOString();
  await withStore('records', 'readwrite', (store) => {
    store.put(record);
  });
  return record;
}

async function deleteRecord(id) {
  const db = await openDb();
  const tx = db.transaction(['records', 'photos'], 'readwrite');
  tx.objectStore('records').delete(id);
  const idx = tx.objectStore('photos').index('byRecord');
  const photos = await reqDone(idx.getAll(id));
  (photos || []).forEach((p) => tx.objectStore('photos').delete(p.id));
  await txDone(tx);
}

async function setDescription(recordId, part, description) {
  const record = await getRecord(recordId);
  if (!record.parts[part]) record.parts[part] = { description: '', photos: [] };
  record.parts[part].description = String(description || '');
  await saveRecord(record);
  return record;
}

async function addPhotos(recordId, part, files) {
  const record = await getRecord(recordId);
  if (!record.parts[part]) record.parts[part] = { description: '', photos: [] };

  const db = await openDb();
  const tx = db.transaction(['records', 'photos'], 'readwrite');
  const added = [];

  for (const file of files) {
    const id = uid();
    const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : 'jpg';
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${id.slice(0, 8)}.${ext}`;
    const photoMeta = { id, filename, createdAt: new Date().toISOString() };
    tx.objectStore('photos').put({
      id,
      recordId,
      part,
      filename,
      mime: file.type || 'image/jpeg',
      blob: file,
      createdAt: photoMeta.createdAt
    });
    record.parts[part].photos.push(photoMeta);
    added.push(photoMeta);
  }

  record.updatedAt = new Date().toISOString();
  tx.objectStore('records').put(record);
  await txDone(tx);
  return added;
}

async function deletePhoto(recordId, part, filename) {
  const record = await getRecord(recordId);
  const partMeta = record.parts[part];
  if (!partMeta) throw new Error('部位不存在');
  const photo = partMeta.photos.find((p) => p.filename === filename);
  if (!photo) throw new Error('照片不存在');

  const db = await openDb();
  const tx = db.transaction(['records', 'photos'], 'readwrite');
  tx.objectStore('photos').delete(photo.id);
  partMeta.photos = partMeta.photos.filter((p) => p.filename !== filename);
  record.updatedAt = new Date().toISOString();
  tx.objectStore('records').put(record);
  await txDone(tx);
}

async function getPhotoBlob(photoId) {
  const row = await withStore('photos', 'readonly', (store) => reqDone(store.get(photoId)));
  if (!row?.blob) throw new Error('照片不存在');
  return row;
}

async function loadRecords() {
  state.records = await listRecords();
  renderHome();
}

function renderHome() {
  const list = $('#record-list');
  const empty = $('#empty-home');
  $('#record-count').textContent = String(state.records.length);

  if (!state.records.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = state.records
    .map(
      (r) => `
      <article class="record-card" data-id="${r.id}">
        <h3>${escapeHtml(r.title || r.plate || '未命名')}</h3>
        <div class="record-meta">
          ${r.plate ? `<span>${escapeHtml(r.plate)}</span>` : ''}
          <span class="badge">${r.photoTotal || 0} 张照片</span>
          <span>${formatTime(r.updatedAt || r.createdAt)}</span>
        </div>
      </article>`
    )
    .join('');

  list.querySelectorAll('.record-card').forEach((card) => {
    card.addEventListener('click', () => openRecord(card.dataset.id));
  });
}

async function openRecord(id) {
  state.current = await getRecord(id);
  renderDetail();
  showView('detail');
}

function renderDetail() {
  const r = state.current;
  if (!r) return;

  $('#detail-title').textContent = r.title || r.plate || '验车详情';
  $('#detail-sub').textContent = [r.plate, r.note].filter(Boolean).join(' · ') || '数据保存在本机，可完全离线使用';

  const done = PARTS.filter((p) => (r.photoCounts?.[p] || 0) > 0).length;
  $('#progress-text').textContent = `${done} / ${PARTS.length}`;
  $('#progress-fill').style.width = `${(done / PARTS.length) * 100}%`;

  const grid = $('#part-grid');
  grid.innerHTML = PARTS
    .map((p) => {
      const count = r.photoCounts?.[p] || 0;
      const desc = r.parts?.[p]?.description || '';
      return `
        <article class="part-card ${count ? 'has-photo' : ''}" data-part="${escapeHtml(p)}">
          <h3>${escapeHtml(p)}</h3>
          <div class="count">
            ${count ? `<span class="badge done">${count} 张</span>` : '未拍'}
            ${desc ? ' · 已描述' : ''}
          </div>
        </article>`;
    })
    .join('');

  grid.querySelectorAll('.part-card').forEach((card) => {
    card.addEventListener('click', () => openPart(card.dataset.part));
  });
}

async function openPart(partName) {
  revokeObjectUrls();
  state.currentPart = partName;
  state.current = await getRecord(state.current.id);
  const part = state.current.parts?.[partName] || { description: '', photos: [] };
  $('#part-title').textContent = partName;
  $('#part-description').value = part.description || '';
  await renderPhotos(part.photos || []);
  showView('part');
}

async function renderPhotos(photos) {
  const grid = $('#photo-grid');
  const empty = $('#empty-photos');

  if (!photos.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  const items = [];
  for (const p of photos) {
    const row = await getPhotoBlob(p.id);
    const url = blobUrl(row.blob);
    items.push(`
      <div class="photo-item">
        <img src="${url}" alt="${escapeHtml(p.filename)}" data-url="${url}" loading="lazy" />
        <button class="del" type="button" data-filename="${escapeHtml(p.filename)}" aria-label="删除">×</button>
      </div>`);
  }
  grid.innerHTML = items.join('');

  grid.querySelectorAll('img').forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.dataset.url));
  });
  grid.querySelectorAll('.del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除这张照片？')) return;
      try {
        await deletePhoto(state.current.id, state.currentPart, btn.dataset.filename);
        await openPart(state.currentPart);
        toast('已删除');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

function openLightbox(url) {
  $('#lightbox-img').src = url;
  $('#lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightbox-img').src = '';
}

function safeName(name) {
  return String(name || '验车').replace(/[\\/:*?"<>|]/g, '_');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: filename,
        text: '车子验车报告'
      });
      toast('已打开系统分享');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        toast('已取消分享');
        return;
      }
    }
  }
  triggerDownload(blob, filename);
  toast('已保存到手机，可用微信/QQ 发送该文件');
}

function formatReportTime(iso) {
  if (!iso) return formatTime(new Date().toISOString());
  return formatTime(iso);
}

async function buildReportParts(record, onlyPart) {
  const names = onlyPart ? [onlyPart] : PARTS;
  return names.map((name) => ({
    name,
    description: record.parts?.[name]?.description || '',
    photos: record.parts?.[name]?.photos || []
  }));
}

async function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-lib="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`加载失败: ${src}`)));
      // If already loaded earlier, resolve on next tick
      setTimeout(() => resolve(), 0);
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.dataset.lib = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`加载失败: ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureExportLibs() {
  if (typeof JSZip !== 'undefined' && window.CheziDocx) return;

  const candidates = [
    'js/export-libs.js',
    './js/export-libs.js',
    'js/jszip.min.js'
  ];

  let lastErr = null;
  for (const src of candidates) {
    try {
      await loadScript(src);
      if (typeof JSZip !== 'undefined' && !window.CheziDocx) {
        await loadScript(src.includes('export-libs') ? src : 'js/docx-export.js');
      }
      if (typeof JSZip !== 'undefined') break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (typeof JSZip === 'undefined') {
    throw new Error((lastErr && lastErr.message) || '导出组件未加载，请重装含 js/export-libs.js 的新版 APK');
  }
  if (!window.CheziDocx) {
    try {
      await loadScript('js/docx-export.js');
    } catch (_) {
      /* ignore */
    }
  }
  if (!window.CheziDocx) {
    throw new Error('Word 组件未加载，请确认 APK 已包含 js/docx-export.js 或 js/export-libs.js');
  }
}

async function exportWord({ onlyPart = null, share = false } = {}) {
  if (!state.current) return;
  await ensureExportLibs();

  const record = await getRecord(state.current.id);
  const parts = await buildReportParts(record, onlyPart);
  const hasContent = parts.some(
    (p) => (p.description && p.description.trim()) || (p.photos && p.photos.length)
  );
  if (!hasContent) throw new Error(onlyPart ? '该部位暂无内容可导出' : '暂无照片或描述可导出');

  toast(share ? '正在生成并准备分享…' : '正在生成 Word…');
  const blob = await CheziDocx.buildInspectionDocx({
    title: record.title || `${record.plate || '车辆'}验车报告`,
    plate: record.plate || '',
    note: record.note || '',
    createdAt: formatReportTime(new Date().toISOString()),
    parts,
    onlyPart,
    getPhotoBlob
  });

  const name = onlyPart
    ? `${safeName(record.plate || record.title)}_${onlyPart}.docx`
    : `${safeName(record.plate || record.title)}_验车报告.docx`;

  if (share) await shareOrDownload(blob, name);
  else {
    triggerDownload(blob, name);
    toast('Word 已导出');
  }
}

async function exportZip({ onlyPart = null } = {}) {
  if (!state.current) return;
  await ensureExportLibs();

  const record = await getRecord(state.current.id);
  const zip = new JSZip();
  const root = safeName(record.plate || record.title || record.id);
  const parts = onlyPart ? [onlyPart] : PARTS;
  let fileCount = 0;

  for (const part of parts) {
    const partMeta = record.parts?.[part];
    if (!partMeta) continue;
    const folder = zip.folder(`${root}/${part}`);
    if (partMeta.description) {
      folder.file('车况描述.txt', partMeta.description);
    }
    for (const p of partMeta.photos || []) {
      const row = await getPhotoBlob(p.id);
      folder.file(p.filename, row.blob);
      fileCount += 1;
    }
  }

  if (!fileCount && !onlyPart) throw new Error('暂无照片可导出');
  if (!fileCount && onlyPart) throw new Error('该部位暂无照片');

  toast('正在打包照片…');
  const blob = await zip.generateAsync({ type: 'blob' });
  const name = onlyPart
    ? `${safeName(record.plate || record.title)}_${onlyPart}.zip`
    : `${safeName(record.plate || record.title)}_验车照片.zip`;
  triggerDownload(blob, name);
  toast('照片 ZIP 已导出');
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;
}

function isNativeApp() {
  return !!(
    window.__CHEZI_NATIVE__ ||
    (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
    location.protocol === 'file:'
  );
}

function isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /MicroMessenger|WeiBo|QQ\//i.test(ua) ||
    (/Android/i.test(ua) && /; wv\)/i.test(ua));
}

function bindEvents() {
  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.back;
      try {
        if (target === 'detail') {
          state.current = await getRecord(state.current.id);
          renderDetail();
        } else if (target === 'home') {
          revokeObjectUrls();
          await loadRecords();
        }
        showView(target);
      } catch (err) {
        toast(err.message);
      }
    });
  });

  $('#btn-new-record').addEventListener('click', () => {
    $('#form-create').reset();
    showView('create');
  });

  $('#form-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const record = await createRecord({
        plate: fd.get('plate'),
        title: fd.get('title'),
        note: fd.get('note')
      });
      toast('已创建（保存在本机）');
      await openRecord(record.id);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-download-all').addEventListener('click', async () => {
    try {
      await exportWord();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-share-all')?.addEventListener('click', async () => {
    try {
      await exportWord({ share: true });
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-export-zip')?.addEventListener('click', async () => {
    try {
      await exportZip();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-delete-record').addEventListener('click', async () => {
    if (!state.current) return;
    if (!confirm('确定删除整条验车记录及全部照片？')) return;
    try {
      await deleteRecord(state.current.id);
      state.current = null;
      revokeObjectUrls();
      toast('已删除');
      await loadRecords();
      showView('home');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-save-desc').addEventListener('click', async () => {
    if (!state.current || !state.currentPart) return;
    try {
      state.current = await setDescription(
        state.current.id,
        state.currentPart,
        $('#part-description').value
      );
      toast('描述已保存');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-download-part').addEventListener('click', async () => {
    try {
      await exportWord({ onlyPart: state.currentPart });
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-share-part')?.addEventListener('click', async () => {
    try {
      await exportWord({ onlyPart: state.currentPart, share: true });
    } catch (err) {
      toast(err.message);
    }
  });

  $('#photo-input').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length || !state.current || !state.currentPart) return;
    try {
      toast(`保存中 ${files.length} 张…`);
      await addPhotos(state.current.id, state.currentPart, files);
      await openPart(state.currentPart);
      toast('已保存到本机');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#lightbox-close').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    $('#install-native-wrap')?.classList.remove('hidden');
  });

  const openInstall = () => openInstallModal();
  $('#btn-install')?.addEventListener('click', openInstall);
  $('#btn-install-hero')?.addEventListener('click', openInstall);
  $('#install-close')?.addEventListener('click', () => $('#install-modal').classList.add('hidden'));
  $('#install-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'install-modal') $('#install-modal').classList.add('hidden');
  });
  $('#btn-native-install')?.addEventListener('click', async () => {
    if (!state.deferredInstall) {
      toast('请按下方手动步骤添加到主屏幕');
      return;
    }
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    toast('请按系统提示完成安装');
  });
}

function openInstallModal() {
  $('#install-modal').classList.remove('hidden');
  $('#install-ios')?.classList.toggle('hidden', !isIos());
  $('#install-android')?.classList.toggle('hidden', !isAndroid());
  const desktop = !isIos() && !isAndroid();
  $('#install-desktop')?.classList.toggle('hidden', !desktop);
  if (state.deferredInstall) $('#install-native-wrap')?.classList.remove('hidden');
}

function initUiHints() {
  $('#btn-server-cfg')?.classList.add('hidden');
  if (isNativeApp() || isStandalone()) {
    $('#btn-install')?.classList.add('hidden');
    $('#btn-install-hero')?.classList.add('hidden');
  }
  if (!isNativeApp() && isInAppBrowser()) {
    $('#browser-warn')?.classList.remove('hidden');
  }
}

async function registerSW() {
  if (isNativeApp() || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
  } catch (_) {
    /* ignore */
  }
}

bindEvents();
initUiHints();
loadRecords().catch((err) => toast(err.message || '本地数据库初始化失败'));
registerSW();
