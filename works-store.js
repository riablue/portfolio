(function () {
  const CATS = ['CONTENT', 'STYLING', 'PRODUCTION', 'EDITORIAL'];
  const cfg = window.RIA_CONFIG || {};
  const CLOUD = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const listeners = [];
  const emit = () => listeners.forEach(fn => { try { fn(); } catch (e) {} });

  // ---------- image processing (shared) ----------
  const resize = (file, max, q) => new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(blob => res({ blob, src: CLOUD ? URL.createObjectURL(blob) : c.toDataURL('image/jpeg', q), w: c.width, h: c.height }), 'image/jpeg', q);
    };
    img.onerror = rej;
    img.src = url;
  });
  const processFile = async (file) => {
    const big = await resize(file, 1800, .86), th = await resize(file, 480, .8);
    const out = { src: big.src, thumb: th.src, w: big.w, h: big.h };
    if (CLOUD) { out._big = big.blob; out._thumb = th.blob; }
    return out;
  };
  const setCover = (item) => {
    const imgs = item.images || [];
    if (imgs.length) { item.img = imgs[0].src; item.thumb = imgs[0].thumb; item.w = imgs[0].w; item.h = imgs[0].h; }
    else { delete item.img; delete item.thumb; }
    return item;
  };

  // ---------- LOCAL adapter (IndexedDB) ----------
  const DB = 'ria-works', STORE = 'works';
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('cat', 'cat'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
      const out = fn(s);
      t.oncomplete = () => { db.close(); res(out && out.result !== undefined ? out.result : out); };
      t.onerror = () => rej(t.error);
    });
  };
  let bc = null; try { bc = new BroadcastChannel('ria-works'); } catch (e) {}
  const localNotify = () => { if (bc) bc.postMessage('changed'); try { localStorage.setItem('ria-works-ping', String(Date.now())); } catch (e) {} emit(); };
  const local = {
    async getAll() { return (await tx('readonly', s => s.getAll())) || []; },
    async put(rows) { await tx('readwrite', s => rows.forEach(r => s.put(r))); localNotify(); },
    async del(id) { await tx('readwrite', s => s.delete(id)); localNotify(); },
    async prepareImages(images) { return images.map(im => { const o = Object.assign({}, im); delete o._big; delete o._thumb; return o; }); },
    async removeImages() {},
    listen() { if (bc) bc.addEventListener('message', emit); window.addEventListener('storage', e => { if (e.key === 'ria-works-ping') emit(); }); }
  };

  // ---------- CLOUD adapter (Supabase) ----------
  let sb = null, sbReady = null;
  const loadSb = () => sbReady || (sbReady = new Promise((res, rej) => {
    const done = () => { sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY); res(sb); };
    if (window.supabase && window.supabase.createClient) return done();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = done; s.onerror = () => rej(new Error('Could not load Supabase client'));
    document.head.appendChild(s);
  }));
  const rowToItem = r => ({ id: r.id, cat: r.cat, title: r.title || '', desc: r.description || '', link: r.link || '', order: r.sort_order || 0, created: r.created_at ? Date.parse(r.created_at) : 0, images: r.images || [], img: (r.images && r.images[0] && r.images[0].src) || undefined, thumb: (r.images && r.images[0] && r.images[0].thumb) || undefined });
  const itemToRow = it => ({ id: it.id, cat: it.cat, title: it.title || '', description: it.desc || '', link: it.link || '', sort_order: it.order || 0, images: it.images || [] });
  const cloud = {
    async getAll() { await loadSb(); const { data, error } = await sb.from('works').select('*'); if (error) throw error; return (data || []).map(rowToItem); },
    async put(rows) { await loadSb(); const { error } = await sb.from('works').upsert(rows.map(itemToRow)); if (error) throw error; emit(); },
    async del(id) { await loadSb(); const { error } = await sb.from('works').delete().eq('id', id); if (error) throw error; emit(); },
    async prepareImages(images, itemId) {
      await loadSb();
      const out = [];
      for (const im of images) {
        if (!im._big) { const o = Object.assign({}, im); delete o._big; delete o._thumb; out.push(o); continue; }
        const key = itemId + '/' + uid();
        const up = async (path, blob) => { const { error } = await sb.storage.from('works').upload(path, blob, { contentType: 'image/jpeg', upsert: true }); if (error) throw error; return sb.storage.from('works').getPublicUrl(path).data.publicUrl; };
        const src = await up(key + '.jpg', im._big), thumb = await up(key + '-thumb.jpg', im._thumb);
        out.push({ src, thumb, w: im.w, h: im.h, path: key });
      }
      return out;
    },
    async removeImages(images) {
      await loadSb();
      const paths = [];
      (images || []).forEach(im => { if (im.path) paths.push(im.path + '.jpg', im.path + '-thumb.jpg'); });
      if (paths.length) await sb.storage.from('works').remove(paths);
    },
    listen() { loadSb().then(() => { sb.channel('works-live').on('postgres_changes', { event: '*', schema: 'public', table: 'works' }, emit).subscribe(); }).catch(() => {}); }
  };

  const A = CLOUD ? cloud : local;
  A.listen();

  const RiaWorks = {
    CATS, CLOUD, processFile,
    async all() {
      const rows = await A.getAll();
      const out = {}; CATS.forEach(c => out[c] = []);
      rows.forEach(r => { if (out[r.cat]) out[r.cat].push(r); });
      CATS.forEach(c => out[c].sort((a, b) => a.order - b.order));
      return out;
    },
    async list(cat) { return (await this.all())[cat] || []; },
    async addPrepared(cat, { title, desc, link, images }) {
      const list = await this.list(cat);
      const id = uid();
      const item = { id, cat, title: title || '', desc: desc || '', link: link || '', order: list.length, created: Date.now() };
      item.images = await A.prepareImages(images || [], id);
      setCover(item);
      await A.put([item]); return item;
    },
    async add(cat, { title, desc, link, files, file }) {
      const fl = files && files.length ? Array.from(files) : (file ? [file] : []);
      const images = []; for (const f of fl) images.push(await processFile(f));
      return this.addPrepared(cat, { title, desc, link, images });
    },
    async update(id, patch) {
      const rows = await A.getAll();
      const cur = rows.find(r => r.id === id); if (!cur) return null;
      const next = Object.assign({}, cur);
      if (patch.title !== undefined) next.title = patch.title;
      if (patch.desc !== undefined) next.desc = patch.desc;
      if (patch.link !== undefined) next.link = patch.link || '';
      if (!next.images) next.images = next.img ? [{ src: next.img, thumb: next.thumb || next.img, w: next.w, h: next.h }] : [];
      let images = patch.images ? patch.images.slice() : next.images.slice();
      const fl = patch.addFiles && patch.addFiles.length ? Array.from(patch.addFiles) : (patch.file ? [patch.file] : []);
      for (const f of fl) images.push(await processFile(f));
      const kept = new Set(images.map(im => im.path).filter(Boolean));
      const dropped = (cur.images || []).filter(im => im.path && !kept.has(im.path));
      next.images = await A.prepareImages(images, id);
      setCover(next);
      await A.put([next]);
      if (dropped.length) A.removeImages(dropped).catch(() => {});
      return next;
    },
    async remove(id) {
      const rows = await A.getAll();
      const cur = rows.find(r => r.id === id);
      await A.del(id);
      if (cur) { A.removeImages(cur.images).catch(() => {}); await this.renumber(cur.cat); }
    },
    async move(id, dir) {
      const rows = await A.getAll();
      const cur = rows.find(r => r.id === id); if (!cur) return;
      const list = rows.filter(r => r.cat === cur.cat).sort((a, b) => a.order - b.order);
      const i = list.findIndex(x => x.id === id), j = i + dir;
      if (j < 0 || j >= list.length) return;
      const t = list[i]; list[i] = list[j]; list[j] = t;
      list.forEach((x, k) => x.order = k);
      await A.put(list);
    },
    async renumber(cat) {
      const list = await this.list(cat);
      list.forEach((x, k) => x.order = k);
      if (list.length) await A.put(list);
    },
    async exportJSON() { return JSON.stringify(await A.getAll()); },
    async importJSON(text) {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Error('bad file');
      await A.put(rows.filter(r => r && r.id && CATS.includes(r.cat)));
    },
    onChange(fn) { listeners.push(fn); },

    // ---------- auth (cloud only) ----------
    async getUser() { if (!CLOUD) return null; await loadSb(); const { data } = await sb.auth.getUser(); return data && data.user || null; },
    async signInWithGoogle() { await loadSb(); const redirectTo = location.origin + location.pathname; const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } }); if (error) throw error; },
    async signOut() { await loadSb(); await sb.auth.signOut(); },
    onAuth(fn) { if (!CLOUD) return; loadSb().then(() => sb.auth.onAuthStateChange((_e, session) => fn(session && session.user || null))); },
    async whoami() { if (!CLOUD) return null; await loadSb(); const { data, error } = await sb.rpc('whoami'); if (error) return { error: error.message }; return data; },
    isAdmin(user) { const list = (cfg.ADMIN_EMAILS || []).map(e => String(e).toLowerCase()); return !!(user && user.email && list.includes(user.email.toLowerCase())); }
  };
  window.RiaWorks = RiaWorks;
})();
