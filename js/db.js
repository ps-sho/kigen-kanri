// IndexedDB ラッパー: オフライン時のデータ保持と未送信キュー(outbox)を担当
const idb = {
  _db: null,

  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('kigen-kanri', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('cache');                                  // サーバーデータのローカル控え
        db.createObjectStore('outbox', { keyPath: 'key', autoIncrement: true }); // 未送信の変更
        db.createObjectStore('photos');                                 // 未送信の写真(Blob)
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },

  async _tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      const req = fn(os);
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  },

  get(store, key)      { return this._tx(store, 'readonly',  os => os.get(key)); },
  put(store, val, key) { return this._tx(store, 'readwrite', os => os.put(val, key)); },
  putRec(store, val)   { return this._tx(store, 'readwrite', os => os.put(val)); },
  del(store, key)      { return this._tx(store, 'readwrite', os => os.delete(key)); },
  all(store) {
    return this._tx(store, 'readonly', os => os.getAll());
  },
  count(store) {
    return this._tx(store, 'readonly', os => os.count());
  },
};

// キャッシュ入出力(key 例: 'stores', 'products', 'lots:<storeId>')
async function cacheGet(key) {
  const rec = await idb.get('cache', key);
  return rec ? rec.data : null;
}
function cachePut(key, data) {
  return idb.put('cache', { data, ts: Date.now() }, key);
}

// 未送信キュー
function outboxAdd(op) {
  return idb.putRec('outbox', { ...op, createdAt: Date.now() });
}
function outboxAll()   { return idb.all('outbox'); }
function outboxDel(k)  { return idb.del('outbox', k); }
function outboxCount() { return idb.count('outbox'); }
