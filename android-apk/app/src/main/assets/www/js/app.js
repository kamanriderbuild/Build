const state = {
  view: 'home',
  records: [],
  current: null,
  currentPart: null,
  deferredInstall: null
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function isNativeApp() {
  return !!(
    window.__CHEZI_NATIVE__ ||
    (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  );
}

function getServerBase() {
  if (!isNativeApp()) return '';
  return (localStorage.getItem('serverBase') || '').replace(/\/$/, '');
}

function assetUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  const base = getServerBase();
  return base ? `${base}${url.startsWith('/') ? url : `/${url}`}` : url;
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

async function api(path, options = {}) {
  const base = getServerBase();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  let res;
  try {
    res = await fetch(url, options);
  } catch (_) {
    throw new Error(isNativeApp() ? '连不上电脑服务，请检查 IP 与 Wi‑Fi，并确认电脑已运行 npm start' : '网络请求失败');
  }
  const ctype = res.headers.get('content-type') || '';
  const data = ctype.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadRecords() {
  const data = await api('/api/records');
  state.records = data.records || [];
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function openRecord(id) {
  const data = await api(`/api/records/${id}`);
  state.current = data;
  renderDetail();
  showView('detail');
}

function renderDetail() {
  const r = state.current;
  if (!r) return;

  $('#detail-title').textContent = r.title || r.plate || '验车详情';
  $('#detail-sub').textContent = [r.plate, r.note].filter(Boolean).join(' · ') || '按部位拍照记录';

  const parts = r.parts || [];
  const done = parts.filter((p) => (r.photoCounts?.[p] || 0) > 0).length;
  $('#progress-text').textContent = `${done} / ${parts.length}`;
  $('#progress-fill').style.width = `${parts.length ? (done / parts.length) * 100 : 0}%`;

  const grid = $('#part-grid');
  grid.innerHTML = parts
    .map((p) => {
      const count = r.photoCounts?.[p] || 0;
      const desc = r.meta?.parts?.[p]?.description || '';
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

function openPart(partName) {
  state.currentPart = partName;
  const part = state.current?.meta?.parts?.[partName] || { description: '', photos: [] };
  $('#part-title').textContent = partName;
  $('#part-description').value = part.description || '';
  renderPhotos(part.photos || []);
  showView('part');
}

function renderPhotos(photos) {
  const grid = $('#photo-grid');
  const empty = $('#empty-photos');

  if (!photos.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.innerHTML = photos
    .map(
      (p) => `
      <div class="photo-item">
        <img src="${assetUrl(p.url)}" alt="${escapeHtml(p.filename)}" data-url="${assetUrl(p.url)}" loading="lazy" />
        <button class="del" type="button" data-filename="${escapeHtml(p.filename)}" aria-label="删除">×</button>
      </div>`
    )
    .join('');

  grid.querySelectorAll('img').forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.dataset.url));
  });
  grid.querySelectorAll('.del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除这张照片？')) return;
      try {
        await api(
          `/api/records/${state.current.id}/parts/${encodeURIComponent(state.currentPart)}/photos/${encodeURIComponent(btn.dataset.filename)}`,
          { method: 'DELETE' }
        );
        await refreshCurrent();
        openPart(state.currentPart);
        toast('已删除');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

async function refreshCurrent() {
  if (!state.current?.id) return;
  state.current = await api(`/api/records/${state.current.id}`);
}

function openLightbox(url) {
  $('#lightbox-img').src = url;
  $('#lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightbox-img').src = '';
}

function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = assetUrl(url);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function bindEvents() {
  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.back;
      if (target === 'detail') {
        await refreshCurrent();
        renderDetail();
      } else if (target === 'home') {
        await loadRecords();
      }
      showView(target);
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
      const record = await api('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plate: fd.get('plate'),
          title: fd.get('title'),
          note: fd.get('note')
        })
      });
      toast('已创建');
      await openRecord(record.id);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-download-all').addEventListener('click', () => {
    if (!state.current) return;
    downloadUrl(`/api/records/${state.current.id}/download`);
    toast('开始打包下载');
  });

  $('#btn-delete-record').addEventListener('click', async () => {
    if (!state.current) return;
    if (!confirm('确定删除整条验车记录及全部照片？')) return;
    try {
      await api(`/api/records/${state.current.id}`, { method: 'DELETE' });
      state.current = null;
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
      await api(
        `/api/records/${state.current.id}/parts/${encodeURIComponent(state.currentPart)}/description`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: $('#part-description').value })
        }
      );
      await refreshCurrent();
      toast('描述已保存');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-download-part').addEventListener('click', () => {
    if (!state.current || !state.currentPart) return;
    downloadUrl(
      `/api/records/${state.current.id}/parts/${encodeURIComponent(state.currentPart)}/download`
    );
    toast('开始下载本部位');
  });

  $('#photo-input').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length || !state.current || !state.currentPart) return;

    const fd = new FormData();
    files.forEach((f) => fd.append('photos', f));

    try {
      toast(`上传中 ${files.length} 张…`);
      await api(
        `/api/records/${state.current.id}/parts/${encodeURIComponent(state.currentPart)}/photos`,
        { method: 'POST', body: fd }
      );
      await refreshCurrent();
      openPart(state.currentPart);
      toast('上传成功');
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
    $('#install-native-wrap').classList.remove('hidden');
  });

  const openInstall = () => openInstallModal();
  $('#btn-install')?.addEventListener('click', openInstall);
  $('#btn-install-hero')?.addEventListener('click', openInstall);
  $('#install-close')?.addEventListener('click', closeInstallModal);
  $('#install-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'install-modal') closeInstallModal();
  });

  $('#btn-native-install')?.addEventListener('click', async () => {
    if (!state.deferredInstall) {
      toast('请按下方手动步骤添加到主屏幕');
      return;
    }
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $('#install-native-wrap')?.classList.add('hidden');
    toast('请按系统提示完成安装');
  });

  $('#btn-server-cfg')?.addEventListener('click', () => showServerSetup('修改电脑服务地址'));
  $('#btn-save-server')?.addEventListener('click', saveServerConfig);
  $('#form-server')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveServerConfig();
  });
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

function isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /MicroMessenger|WeiBo|QQ\//i.test(ua) ||
    (/Android/i.test(ua) && /; wv\)/i.test(ua));
}

async function openInstallModal() {
  const modal = $('#install-modal');
  modal.classList.remove('hidden');

  $('#install-ios').classList.toggle('hidden', !isIos());
  $('#install-android').classList.toggle('hidden', !isAndroid());
  // 电脑端或无法识别时，显示扫码指引；手机也显示本机地址方便复制
  const showDesktopHelp = !isIos() && !isAndroid();
  $('#install-desktop').classList.remove('hidden');
  if (showDesktopHelp) {
    $('#install-ios').classList.add('hidden');
    $('#install-android').classList.add('hidden');
  }

  if (state.deferredInstall) {
    $('#install-native-wrap').classList.remove('hidden');
  }

  try {
    const info = await api('/api/access-info');
    const list = $('#access-urls');
    const urls = info.urls || [];
    list.innerHTML = urls
      .map((u) => `<a class="url-chip" href="${u}" target="_blank" rel="noopener">${u}</a>`)
      .join('') || `<span class="hint">当前地址：${location.origin}</span>`;

    if (info.qrDataUrl) {
      $('#qr-img').src = info.qrDataUrl;
      $('#qr-box').classList.remove('hidden');
    } else {
      $('#qr-box').classList.add('hidden');
    }
  } catch (_) {
    $('#access-urls').innerHTML = `<a class="url-chip" href="${location.origin}">${location.origin}</a>`;
  }
}

function closeInstallModal() {
  $('#install-modal').classList.add('hidden');
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (_) {
    /* ignore */
  }
}

function initInstallHints() {
  if (isNativeApp()) {
    $('#btn-install')?.classList.add('hidden');
    $('#btn-install-hero')?.classList.add('hidden');
    $('#btn-server-cfg')?.classList.remove('hidden');
    return;
  }
  if (isInAppBrowser()) {
    $('#browser-warn').classList.remove('hidden');
  }
  if (isStandalone()) {
    $('#btn-install').classList.add('hidden');
    $('#btn-install-hero').classList.add('hidden');
  }
}

function normalizeServerInput(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  return v.replace(/\/$/, '');
}

async function ensureServerConfig() {
  if (!isNativeApp()) return true;
  let base = getServerBase();
  if (!base) {
    showServerSetup('请填写电脑局域网地址，例如 192.168.3.67:3000');
    return false;
  }
  try {
    await api('/api/parts');
    return true;
  } catch (err) {
    showServerSetup(err.message);
    return false;
  }
}

function showServerSetup(msg) {
  const input = $('#server-base-input');
  if (input && !input.value) input.value = getServerBase().replace(/^https?:\/\//, '') || '192.168.3.67:3000';
  if (msg) $('#server-setup-msg').textContent = msg;
  showView('server');
}

async function saveServerConfig() {
  const base = normalizeServerInput($('#server-base-input').value);
  if (!base) {
    toast('请输入电脑地址');
    return;
  }
  localStorage.setItem('serverBase', base);
  try {
    await api('/api/parts');
    toast('连接成功');
    await loadRecords();
    showView('home');
  } catch (err) {
    toast(err.message);
  }
}

bindEvents();
initInstallHints();

(async () => {
  const ok = await ensureServerConfig();
  if (ok) {
    loadRecords().catch((err) => toast(err.message));
  }
})();
registerSW();
