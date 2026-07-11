/* ════════════════════════════════════════════
   期限管理アプリ 本体
   ════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  sb: null,
  session: null,
  myStoreId: null,       // ログイン中アカウントの店舗(書き込み先)
  viewStoreId: null,     // 一覧に表示中の店舗
  stores: [],
  products: [],          // 商品マスタ(全店舗共通)
  lots: [],              // 表示店舗のロット
  filter: 'all',
  sort: 'expiry',
  search: '',
  tab: 'list',
  localPhotoUrls: {},    // 未同期写真のプレビュー用(セッション内のみ)
};

/* ───────── 起動 ───────── */

async function init() {
  $('app-version').textContent = CONFIG.APP_VERSION;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  state.sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
  await idb.open();
  bindEvents();

  window.addEventListener('online', () => { updateBadges(); flushOutbox().then(refreshData); });
  window.addEventListener('offline', updateBadges);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScan();
    else if (state.tab === 'scan' && !$('view-main').hidden) startScan();
  });

  const { data } = await state.sb.auth.getSession().catch(() => ({ data: {} }));
  state.session = data?.session || null;

  if (state.session) {
    await showStart();
  } else if (await cacheGet('me')) {
    // オフラインでセッション復元に失敗した場合もキャッシュで作業を継続できる
    if (!navigator.onLine) await showStart();
    else await showLogin();
  } else {
    await showLogin();
  }
  updateBadges();
}

function showView(name) {
  ['view-login', 'view-start', 'view-main', 'view-form'].forEach((v) => {
    $(v).hidden = v !== name;
  });
  if (name !== 'view-main') stopScan();
}

/* ───────── ログイン ───────── */

async function showLogin() {
  showView('view-login');
  $('login-error').hidden = true;
  $('login-offline').hidden = navigator.onLine;

  let stores = await cacheGet('stores');
  if (navigator.onLine) {
    const { data } = await state.sb.from('stores').select('*').order('sort_order');
    if (data && data.length) { stores = data; cachePut('stores', data); }
  }
  stores = stores || [];
  state.stores = stores;

  const last = localStorage.getItem('kigen.lastStoreId');
  const grid = $('login-stores');
  grid.innerHTML = stores.map((s) =>
    `<button type="button" data-store="${s.id}" class="${s.id === last ? 'selected' : ''}">${esc(s.name)}</button>`
  ).join('') || '<p class="muted">店舗一覧を取得できません。通信環境をご確認ください。</p>';
}

async function doLogin(e) {
  e.preventDefault();
  const sel = document.querySelector('#login-stores button.selected');
  const errEl = $('login-error');
  errEl.hidden = true;
  if (!sel) { errEl.textContent = '店舗を選択してください'; errEl.hidden = false; return; }
  const store = state.stores.find((s) => s.id === sel.dataset.store);
  const btn = $('login-btn');
  btn.disabled = true; btn.textContent = 'ログイン中…';
  try {
    const { data, error } = await state.sb.auth.signInWithPassword({
      email: store.login_email,
      password: $('login-password').value,
    });
    if (error) throw error;
    state.session = data.session;
    localStorage.setItem('kigen.lastStoreId', store.id);
    $('login-password').value = '';
    await enterMain();
  } catch (err) {
    errEl.textContent = /credentials/i.test(err.message || '')
      ? 'パスワードが違います' : 'ログインできません: ' + (err.message || err);
    errEl.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'ログイン';
  }
}

/* ───────── 作業開始確認 ───────── */

async function showStart() {
  const me = await resolveMe();
  if (!me) { await showLogin(); return; }
  $('start-store-name').textContent = me.storeName;
  showView('view-start');
}

// 自分のアカウントがどの店舗か(キャッシュ優先)
async function resolveMe() {
  const cached = await cacheGet('me');
  if (state.session && navigator.onLine) {
    const uid = state.session.user.id;
    const { data } = await state.sb.from('store_members')
      .select('store_id, stores(name)').eq('user_id', uid).single();
    if (data) {
      const me = { userId: uid, storeId: data.store_id, storeName: data.stores.name };
      cachePut('me', me);
      return me;
    }
  }
  return cached;
}

/* ───────── メイン画面 ───────── */

async function enterMain() {
  const me = await resolveMe();
  if (!me) { await showLogin(); return; }
  state.myStoreId = me.storeId;
  state.viewStoreId = me.storeId;
  localStorage.setItem('kigen.lastStoreId', me.storeId);

  await loadFromCache();
  showView('view-main');
  switchTab('list');
  renderAll();
  refreshData();   // 裏で最新化
  flushOutbox();
}

async function loadFromCache() {
  state.stores = (await cacheGet('stores')) || state.stores || [];
  state.products = (await cacheGet('products')) || [];
  state.lots = (await cacheGet('lots:' + state.viewStoreId)) || [];
}

async function refreshData() {
  if (!navigator.onLine || !state.session) return;
  try {
    const [st, pr, lo] = await Promise.all([
      state.sb.from('stores').select('*').order('sort_order'),
      state.sb.from('products').select('*'),
      state.sb.from('lots').select('*').eq('store_id', state.viewStoreId).order('expiry_date'),
    ]);
    if (st.data) { state.stores = st.data; cachePut('stores', st.data); }
    if (pr.data) { state.products = pr.data; cachePut('products', pr.data); }
    if (lo.data) { state.lots = lo.data; cachePut('lots:' + state.viewStoreId, lo.data); }
    renderAll();
  } catch (_) { /* オフライン時はキャッシュ表示のまま */ }
}

function renderAll() {
  renderHeader();
  renderStoreSelect();
  renderList();
  renderSettings();
}

function renderHeader() {
  const my = state.stores.find((s) => s.id === state.myStoreId);
  $('header-store-name').textContent = my ? my.name : '—';
  $('settings-store-name').textContent = my ? my.name : '—';
}

function renderStoreSelect() {
  const sel = $('view-store-select');
  sel.innerHTML = state.stores.map((s) =>
    `<option value="${s.id}" ${s.id === state.viewStoreId ? 'selected' : ''}>${esc(s.name)}${s.id === state.myStoreId ? '(自店舗)' : ''}</option>`
  ).join('');
  $('readonly-note').hidden = state.viewStoreId === state.myStoreId;
}

/* ───────── 期限の計算 ───────── */

function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}
function levelOf(days) {
  if (days < 0) return 'expired';
  if (days <= 7) return 'danger';
  if (days <= 30) return 'warn';
  return 'ok';
}
function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}/${m}/${d}`;
}
function badgeHtml(dateStr) {
  const days = daysUntil(dateStr);
  const lv = levelOf(days);
  const label = lv === 'expired' ? `期限切れ ${-days}日`
    : days === 0 ? '本日まで'
    : `あと${days}日`;
  return `<span class="badge badge-${lv}">${label}</span>`;
}

/* ───────── 商品一覧 ───────── */

function buildGroups() {
  const prodMap = new Map(state.products.map((p) => [p.id, p]));
  const groups = new Map();
  for (const lot of state.lots) {
    const p = prodMap.get(lot.product_id);
    if (!p) continue;
    if (!groups.has(p.id)) groups.set(p.id, { product: p, lots: [] });
    groups.get(p.id).lots.push(lot);
  }
  for (const g of groups.values()) g.lots.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
  return [...groups.values()];
}

function renderList() {
  let groups = buildGroups();

  // 警告件数(商品単位)
  const counts = { expired: 0, danger: 0, warn: 0 };
  for (const g of groups) {
    const lvs = g.lots.filter((l) => l.quantity > 0).map((l) => levelOf(daysUntil(l.expiry_date)));
    if (lvs.includes('expired')) counts.expired++;
    if (lvs.includes('danger')) counts.danger++;
    if (lvs.includes('warn')) counts.warn++;
  }
  $('cnt-expired').textContent = counts.expired;
  $('cnt-danger').textContent = counts.danger;
  $('cnt-warn').textContent = counts.warn;

  // 検索
  const q = state.search.trim().toLowerCase();
  if (q) {
    groups = groups.filter((g) =>
      g.product.name.toLowerCase().includes(q) || (g.product.barcode || '').includes(q));
  }
  // 絞り込み
  if (state.filter !== 'all') {
    groups = groups.filter((g) =>
      g.lots.some((l) => l.quantity > 0 && levelOf(daysUntil(l.expiry_date)) === state.filter));
  }
  // 並び替え
  if (state.sort === 'expiry') {
    groups.sort((a, b) => (a.lots[0]?.expiry_date || '9999').localeCompare(b.lots[0]?.expiry_date || '9999'));
  } else if (state.sort === 'name') {
    groups.sort((a, b) => a.product.name.localeCompare(b.product.name, 'ja'));
  } else {
    const total = (g) => g.lots.reduce((n, l) => n + l.quantity, 0);
    groups.sort((a, b) => total(a) - total(b));
  }

  $('list-empty').hidden = groups.length > 0;
  $('product-list').innerHTML = groups.map((g) => {
    const lotLines = g.lots.map((l) =>
      `<div class="lot-line">${badgeHtml(l.expiry_date)}<span>${fmtDate(l.expiry_date)}</span><span class="lot-qty">在庫 ${l.quantity}</span></div>`
    ).join('');
    return `<div class="product-card" data-product="${g.product.id}">
      ${thumbHtml(g.product)}
      <div class="product-info">
        <div class="product-name">${esc(g.product.name)}</div>
        ${lotLines}
      </div>
    </div>`;
  }).join('');
}

function thumbHtml(p, big = false) {
  const url = p.photo_url || state.localPhotoUrls[p.id];
  return url
    ? `<img class="product-thumb" src="${esc(url)}" alt="" loading="lazy">`
    : `<div class="product-thumb">📦</div>`;
}

/* ───────── 商品詳細シート ───────── */

let sheetProductId = null;

async function openSheet(productId) {
  sheetProductId = productId;
  renderSheet();
  $('sheet-backdrop').hidden = false;
  $('sheet-product').hidden = false;
  loadOtherStores(productId);
}

function closeSheet() {
  sheetProductId = null;
  $('sheet-backdrop').hidden = true;
  $('sheet-product').hidden = true;
}

function renderSheet() {
  const p = state.products.find((x) => x.id === sheetProductId);
  if (!p) { closeSheet(); return; }
  const editable = state.viewStoreId === state.myStoreId;
  const lots = state.lots
    .filter((l) => l.product_id === p.id)
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
  const storeName = state.stores.find((s) => s.id === state.viewStoreId)?.name || '';

  const lotRows = lots.map((l) => `
    <div class="lot-row" data-lot="${l.id}">
      <div class="lot-row-date">${fmtDate(l.expiry_date)}${badgeHtml(l.expiry_date)}</div>
      ${editable ? `<button class="qty-btn" data-act="minus">−</button>` : ''}
      <span class="lot-row-qty">${l.quantity}</span>
      ${editable ? `<button class="qty-btn" data-act="plus">＋</button>
      <button class="lot-del-btn" data-act="del" title="この期限を削除">🗑</button>` : ''}
    </div>`).join('') || '<p class="muted">この店舗には在庫が登録されていません</p>';

  $('sheet-body').innerHTML = `
    <div class="sheet-product-head">
      ${thumbHtml(p, true)}
      <div>
        <div class="sheet-product-name">${esc(p.name)}
          <button class="btn-icon" id="sheet-rename" title="商品名を変更">✏️</button>
        </div>
        ${p.barcode ? `<div class="sheet-barcode">バーコード: ${esc(p.barcode)}</div>` : ''}
      </div>
    </div>
    <div class="sheet-section-title">${esc(storeName)} の期限と在庫</div>
    ${lotRows}
    ${editable ? `<button class="btn btn-secondary" id="sheet-add-lot">＋ 新しい期限(入荷ロット)を追加</button>` : ''}
    <div class="sheet-section-title">他店舗の在庫状況</div>
    <div id="sheet-other-stores"><p class="muted">${navigator.onLine ? '読み込み中…' : 'オフラインのため表示できません'}</p></div>
  `;
}

async function loadOtherStores(productId) {
  if (!navigator.onLine || !state.session) return;
  const { data } = await state.sb.from('lots')
    .select('store_id, expiry_date, quantity')
    .eq('product_id', productId).order('expiry_date');
  const el = document.getElementById('sheet-other-stores');
  if (!el || sheetProductId !== productId) return;
  const byStore = new Map();
  for (const l of (data || [])) {
    if (l.store_id === state.viewStoreId) continue;
    if (!byStore.has(l.store_id)) byStore.set(l.store_id, []);
    byStore.get(l.store_id).push(l);
  }
  if (!byStore.size) { el.innerHTML = '<p class="muted">他店舗に在庫はありません</p>'; return; }
  el.innerHTML = [...byStore.entries()].map(([sid, ls]) => {
    const name = state.stores.find((s) => s.id === sid)?.name || '不明な店舗';
    const detail = ls.map((l) => `${fmtDate(l.expiry_date)} ×${l.quantity}`).join(' / ');
    return `<div class="other-store-row"><b>${esc(name)}</b><span>${detail}</span></div>`;
  }).join('');
}

/* ───────── 在庫の増減・削除 ───────── */

const lotTimers = new Map();

function changeLotQty(lotId, delta) {
  const lot = state.lots.find((l) => l.id === lotId);
  if (!lot) return;
  lot.quantity = Math.max(0, lot.quantity + delta);
  cachePut('lots:' + state.viewStoreId, state.lots);
  const row = document.querySelector(`.lot-row[data-lot="${lotId}"] .lot-row-qty`);
  if (row) row.textContent = lot.quantity;
  renderList();
  clearTimeout(lotTimers.get(lotId));
  lotTimers.set(lotId, setTimeout(() => {
    queueOp({ type: 'lot_save', lot: { ...lot } });
  }, 500));
}

function deleteLot(lotId) {
  const lot = state.lots.find((l) => l.id === lotId);
  if (!lot) return;
  if (!confirm('この期限の在庫記録を削除しますか?')) return;
  state.lots = state.lots.filter((l) => l.id !== lotId);
  cachePut('lots:' + state.viewStoreId, state.lots);
  queueOp({ type: 'lot_delete', id: lotId });
  renderSheet();
  renderList();
  toast('削除しました');
}

/* ───────── 登録フォーム ───────── */

const formState = { mode: 'newProduct', product: null, photoBlob: null };

function openForm(mode, opts = {}) {
  formState.mode = mode;
  formState.product = opts.product || null;
  formState.photoBlob = null;
  $('form-title').textContent = mode === 'addLot' ? '期限を追加' : '商品を登録';
  $('f-barcode').value = opts.barcode || formState.product?.barcode || '';
  $('f-name').value = formState.product?.name || '';
  $('f-name').readOnly = mode === 'addLot';
  $('f-photo-preview').hidden = true;
  $('f-photo-preview').src = '';
  $('ocr-btn').hidden = true;
  $('ocr-chips').innerHTML = '';
  $('ocr-status').hidden = true;
  $('f-expiry').value = '';
  $('f-expiry-month').value = '';
  $('f-month-only').checked = false;
  $('f-expiry').hidden = false;
  $('f-expiry-month').hidden = true;
  $('f-qty').value = 1;
  // 期限追加モードでは写真・バーコード欄は隠す
  $('f-barcode').closest('.field').hidden = mode === 'addLot';
  $('f-photo').closest('.field').hidden = mode === 'addLot';
  if (formState.product?.photo_url) {
    $('f-photo-preview').src = formState.product.photo_url;
    $('f-photo-preview').hidden = false;
  }
  showView('view-form');
}

async function onPhotoSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const blob = await compressImage(file);
    formState.photoBlob = blob;
    const url = URL.createObjectURL(blob);
    $('f-photo-preview').src = url;
    $('f-photo-preview').hidden = false;
    $('ocr-btn').hidden = false;
  } catch (err) {
    toast('写真を読み込めませんでした', true);
  }
  e.target.value = '';
}

function compressImage(file, maxSize = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('圧縮に失敗')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('読込に失敗')); };
    img.src = url;
  });
}

function getExpiryValue() {
  if ($('f-month-only').checked) {
    const v = $('f-expiry-month').value;          // "2026-08"
    if (!v) return null;
    const [y, m] = v.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();     // 月末日
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  }
  return $('f-expiry').value || null;
}

async function saveForm(e) {
  e.preventDefault();
  const name = $('f-name').value.trim();
  const expiry = getExpiryValue();
  const qty = Math.max(0, parseInt($('f-qty').value, 10) || 0);
  if (!name) { toast('商品名を入力してください', true); return; }
  if (!expiry) { toast('期限を入力してください', true); return; }

  let product = formState.product;

  if (formState.mode !== 'addLot') {
    const barcode = $('f-barcode').value.trim() || null;
    // 同じバーコードの既存商品があれば流用(重複登録防止)
    const existing = barcode ? state.products.find((p) => p.barcode === barcode) : null;
    product = existing
      ? { ...existing, name }
      : { id: crypto.randomUUID(), barcode, name, photo_url: null };

    if (formState.photoBlob) {
      await idb.put('photos', formState.photoBlob, product.id);
      state.localPhotoUrls[product.id] = URL.createObjectURL(formState.photoBlob);
    }
    // ローカル反映
    const idx = state.products.findIndex((p) => p.id === product.id);
    if (idx >= 0) state.products[idx] = product; else state.products.push(product);
    cachePut('products', state.products);
    queueOp({ type: 'product_save', product: { id: product.id, barcode: product.barcode, name: product.name, photo_url: product.photo_url }, photoId: formState.photoBlob ? product.id : null });
  }

  // ロット保存(同じ期限が既にあれば在庫を合算)
  const dup = state.lots.find((l) => l.product_id === product.id && l.expiry_date === expiry);
  if (dup) {
    dup.quantity += qty;
    queueOp({ type: 'lot_save', lot: { ...dup } });
    toast('同じ期限があったため在庫を合算しました');
  } else {
    const lot = {
      id: crypto.randomUUID(), product_id: product.id,
      store_id: state.myStoreId, expiry_date: expiry, quantity: qty,
    };
    state.lots.push(lot);
    queueOp({ type: 'lot_save', lot });
    toast('保存しました');
  }
  cachePut('lots:' + state.viewStoreId, state.lots);

  showView('view-main');
  switchTab('list');
  renderAll();
}

/* ───────── OCR(写真から商品名候補) ───────── */

async function runOcr() {
  if (!formState.photoBlob) return;
  const statusEl = $('ocr-status');
  statusEl.hidden = false;
  $('ocr-btn').disabled = true;
  try {
    statusEl.textContent = '文字認識の準備中…(初回は1〜2分かかることがあります)';
    if (!window.Tesseract) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        s.onload = resolve; s.onerror = () => reject(new Error('通信環境を確認してください'));
        document.head.appendChild(s);
      });
    }
    const worker = await Tesseract.createWorker('jpn', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          statusEl.textContent = `文字を認識中… ${Math.round(m.progress * 100)}%`;
        }
      },
    });
    const { data } = await worker.recognize(formState.photoBlob);
    await worker.terminate();
    const candidates = [...new Set(
      data.text.split('\n')
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter((s) => s.replace(/[^ぁ-んァ-ヶ一-龠a-zA-Z0-9]/g, '').length >= 3)
    )].sort((a, b) => b.length - a.length).slice(0, 6);
    if (!candidates.length) {
      statusEl.textContent = '文字を読み取れませんでした。商品名がはっきり写るように撮影してみてください。';
    } else {
      statusEl.textContent = '候補をタップすると商品名に入ります:';
      $('ocr-chips').innerHTML = candidates.map((c) =>
        `<button type="button" class="chip" data-ocr="${esc(c)}">${esc(c)}</button>`).join('');
    }
  } catch (err) {
    statusEl.textContent = '文字認識に失敗しました: ' + (err.message || err);
  } finally {
    $('ocr-btn').disabled = false;
  }
}

/* ───────── バーコード読み取り ───────── */

let zxingReader = null;
let lastScan = { code: null, t: 0 };
let audioCtx = null;

function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 1400; gain.gain.value = 0.15;
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.09);
  } catch (_) {}
  if (navigator.vibrate) navigator.vibrate(80);
}

async function startScan() {
  if (zxingReader) return;
  const status = $('scan-status');
  status.textContent = 'カメラを起動しています…';
  try {
    const F = ZXing.BarcodeFormat;
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF,
      F.RSS_14, F.RSS_EXPANDED, F.QR_CODE,
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxingReader = new ZXing.BrowserMultiFormatReader(hints, 250);
    await zxingReader.decodeFromConstraints(
      { audio: false, video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } },
      $('scan-video'),
      (result) => { if (result) onBarcode(result.getText()); }
    );
    status.textContent = 'バーコードを枠内にかざしてください';
  } catch (err) {
    zxingReader = null;
    status.textContent = 'カメラを使用できません。ブラウザの設定でカメラを許可してください。';
  }
}

function stopScan() {
  if (zxingReader) { try { zxingReader.reset(); } catch (_) {} zxingReader = null; }
}

function onBarcode(code) {
  const now = Date.now();
  if (code === lastScan.code && now - lastScan.t < 3000) return;
  lastScan = { code, t: now };
  beep();
  handleBarcode(code);
}

function handleBarcode(code) {
  $('scan-status').textContent = `読み取りました: ${code}`;
  const product = state.products.find((p) => p.barcode === code);
  if (product) {
    // 登録済み商品 → 詳細シートで在庫・期限をすぐ更新できる
    openSheet(product.id);
  } else {
    if (state.viewStoreId !== state.myStoreId) {
      toast('未登録の商品です(自店舗表示に切り替えると登録できます)', true);
      return;
    }
    stopScan();
    openForm('newProduct', { barcode: code });
    toast('未登録の商品です。情報を入力してください');
  }
}

/* ───────── 同期(未送信キューの送信) ───────── */

let flushing = false;

async function queueOp(op) {
  await outboxAdd(op);
  updateBadges();
  flushOutbox();
}

function isNetworkError(e) {
  const msg = String(e?.message || e || '');
  return e instanceof TypeError || /fetch|network|load failed|failed to fetch|timeout/i.test(msg);
}

async function flushOutbox() {
  if (flushing || !navigator.onLine || !state.session) { updateBadges(); return; }
  flushing = true;
  let failed = false;
  try {
    const ops = await outboxAll();
    for (const op of ops) {
      try {
        await applyOp(op);
        await outboxDel(op.key);
      } catch (e) {
        if (isNetworkError(e) || e?.status === 401 || e?.status === 403) { failed = true; break; }
        // サーバーに受け付けられない変更(競合など)は破棄して知らせる
        await outboxDel(op.key);
        toast('同期できなかった変更が1件ありました', true);
      }
    }
  } finally {
    flushing = false;
    updateBadges();
    if (!failed) refreshDataSilent();
  }
}

let refreshTimer = null;
function refreshDataSilent() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshData, 800);
}

async function applyOp(op) {
  const sb = state.sb;
  if (op.type === 'product_save') {
    const p = { ...op.product };
    if (op.photoId) {
      const blob = await idb.get('photos', op.photoId);
      if (blob) {
        const path = `products/${op.photoId}_${op.createdAt}.jpg`;
        const up = await sb.storage.from('photos').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (up.error) throw up.error;
        p.photo_url = sb.storage.from('photos').getPublicUrl(path).data.publicUrl;
      }
    }
    const { error } = await sb.from('products').upsert(p);
    if (error) throw Object.assign(new Error(error.message), { status: error.code === '42501' ? 403 : 0 });
    if (op.photoId) await idb.del('photos', op.photoId);
  } else if (op.type === 'lot_save') {
    const { error } = await sb.from('lots').upsert(op.lot);
    if (error) throw Object.assign(new Error(error.message), { status: 0 });
  } else if (op.type === 'lot_delete') {
    const { error } = await sb.from('lots').delete().eq('id', op.id);
    if (error) throw Object.assign(new Error(error.message), { status: 0 });
  } else if (op.type === 'store_rename') {
    const { error } = await sb.from('stores').update({ name: op.name }).eq('id', op.id);
    if (error) throw Object.assign(new Error(error.message), { status: 0 });
  }
}

async function updateBadges() {
  const n = await outboxCount().catch(() => 0);
  $('sync-badge').hidden = n === 0;
  $('sync-count').textContent = n;
  $('settings-sync-count').textContent = n;
  $('offline-badge').hidden = navigator.onLine;
}

/* ───────── 設定 ───────── */

function renderSettings() {
  $('settings-stores').innerHTML = state.stores.map((s) => `
    <div class="settings-store-row">
      <span>${esc(s.name)}${s.id === state.myStoreId ? ' <b>(自店舗)</b>' : ''}</span>
      <button class="rename-btn" data-rename="${s.id}">名前を変更</button>
    </div>`).join('');
}

function renameStore(storeId) {
  const store = state.stores.find((s) => s.id === storeId);
  if (!store) return;
  const name = prompt('新しい店舗名を入力してください', store.name);
  if (!name || !name.trim() || name.trim() === store.name) return;
  store.name = name.trim();
  cachePut('stores', state.stores);
  queueOp({ type: 'store_rename', id: storeId, name: store.name });
  renderAll();
  toast('店舗名を変更しました');
}

async function doLogout() {
  const n = await outboxCount().catch(() => 0);
  if (n > 0 && !confirm(`未送信の変更が ${n} 件あります。通信できる場所で同期してからのログアウトをおすすめします。ログアウトしますか?`)) return;
  if (!confirm('ログアウトして店舗を切り替えますか?')) return;
  await state.sb.auth.signOut().catch(() => {});
  state.session = null;
  state.myStoreId = null;
  await showLogin();
}

/* ───────── タブ・イベント ───────── */

function switchTab(tab) {
  state.tab = tab;
  ['list', 'scan', 'settings'].forEach((t) => {
    $('tab-' + t).hidden = t !== tab;
  });
  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'scan') startScan(); else stopScan();
  if (tab === 'settings') updateBadges();
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function bindEvents() {
  // ログイン
  $('login-stores').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-store]');
    if (!btn) return;
    document.querySelectorAll('#login-stores button').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
  $('login-form').addEventListener('submit', doLogin);

  // 開始画面
  $('start-btn').addEventListener('click', enterMain);
  $('start-switch').addEventListener('click', async () => {
    await state.sb.auth.signOut().catch(() => {});
    state.session = null;
    showLogin();
  });

  // ナビ
  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 一覧
  $('view-store-select').addEventListener('change', async (e) => {
    state.viewStoreId = e.target.value;
    state.lots = (await cacheGet('lots:' + state.viewStoreId)) || [];
    renderStoreSelect();
    renderList();
    refreshData();
  });
  $('search-box').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });
  $('filter-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    document.querySelectorAll('#filter-chips .chip').forEach((c) =>
      c.classList.toggle('active', c === chip));
    renderList();
  });
  $('sort-select').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
  $('product-list').addEventListener('click', (e) => {
    const card = e.target.closest('.product-card');
    if (card) openSheet(card.dataset.product);
  });

  // スキャン
  $('manual-barcode-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('manual-barcode').value.trim();
    if (code) { handleBarcode(code); $('manual-barcode').value = ''; }
  });
  $('no-barcode-btn').addEventListener('click', () => {
    if (state.viewStoreId !== state.myStoreId) { toast('自店舗表示に切り替えてください', true); return; }
    stopScan();
    openForm('newProduct');
  });

  // 詳細シート
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('sheet-body').addEventListener('click', (e) => {
    const lotRow = e.target.closest('.lot-row');
    const act = e.target.dataset.act;
    if (lotRow && act) {
      if (state.viewStoreId !== state.myStoreId) return;
      if (act === 'plus') changeLotQty(lotRow.dataset.lot, 1);
      if (act === 'minus') changeLotQty(lotRow.dataset.lot, -1);
      if (act === 'del') deleteLot(lotRow.dataset.lot);
      return;
    }
    if (e.target.id === 'sheet-add-lot') {
      const p = state.products.find((x) => x.id === sheetProductId);
      closeSheet();
      openForm('addLot', { product: p });
    }
    if (e.target.id === 'sheet-rename' || e.target.closest('#sheet-rename')) {
      const p = state.products.find((x) => x.id === sheetProductId);
      const name = prompt('商品名を変更', p.name);
      if (name && name.trim() && name.trim() !== p.name) {
        p.name = name.trim();
        cachePut('products', state.products);
        queueOp({ type: 'product_save', product: { id: p.id, barcode: p.barcode, name: p.name, photo_url: p.photo_url }, photoId: null });
        renderSheet(); renderList();
      }
    }
  });

  // フォーム
  $('form-back').addEventListener('click', () => { showView('view-main'); switchTab(state.tab); });
  $('product-form').addEventListener('submit', saveForm);
  $('f-photo').addEventListener('change', onPhotoSelected);
  $('ocr-btn').addEventListener('click', runOcr);
  $('ocr-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ocr]');
    if (chip) { $('f-name').value = chip.dataset.ocr; }
  });
  $('f-month-only').addEventListener('change', (e) => {
    $('f-expiry').hidden = e.target.checked;
    $('f-expiry-month').hidden = !e.target.checked;
    $('f-expiry').required = !e.target.checked;
  });
  $('f-qty-plus').addEventListener('click', () => { $('f-qty').value = (parseInt($('f-qty').value, 10) || 0) + 1; });
  $('f-qty-minus').addEventListener('click', () => { $('f-qty').value = Math.max(0, (parseInt($('f-qty').value, 10) || 0) - 1); });

  // 設定
  $('settings-stores').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rename]');
    if (btn) renameStore(btn.dataset.rename);
  });
  $('sync-now-btn').addEventListener('click', async () => {
    if (!navigator.onLine) { toast('オフラインです。通信できる場所でお試しください', true); return; }
    await flushOutbox();
    await refreshData();
    toast('同期しました');
  });
  $('logout-btn').addEventListener('click', doLogout);
}

init();
