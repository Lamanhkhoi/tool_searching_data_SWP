/* app.js — giao diện. Lưu kết quả + key trong chrome.storage.local (fallback localStorage khi mở ngoài extension). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // ---------- storage ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(k) {
      if (hasChrome) return (await chrome.storage.local.get(k))[k];
      try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; }
    },
    async set(k, v) {
      if (hasChrome) return chrome.storage.local.set({ [k]: v });
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* bỏ qua */ }
    },
  };

  let runs = [];          // các lượt chạy (search / snowball)
  let selected = {};      // key bản ghi → true/false
  let keys = {};
  const stopFlag = { stop: false };

  const recKey = r => r.doi ? 'doi:' + r.doi : 't:' + Core.normTitle(r.title);

  function log(msg) {
    const el = $('#log');
    const t = new Date().toLocaleTimeString('vi-VN');
    el.textContent += `[${t}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }

  // ---------- tabs ----------
  $$('.tab').forEach(b => b.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === b));
    $$('.panel').forEach(p => p.classList.add('hidden'));
    $('#tab-' + b.dataset.tab).classList.remove('hidden');
    if (b.dataset.tab === 'results') render();
  }));

  // ---------- keys ----------
  const KEY_FIELDS = ['openalex', 'mailto', 's2', 'ieee', 'serpapi', 'springer'];
  async function loadKeys() {
    keys = (await store.get('rbl_keys')) || {};
    KEY_FIELDS.forEach(k => { $('#k_' + k).value = keys[k] || ''; });
  }
  $('#btnSaveKeys').addEventListener('click', async () => {
    KEY_FIELDS.forEach(k => { keys[k] = $('#k_' + k).value.trim(); });
    await store.set('rbl_keys', keys);
    $('#keyMsg').textContent = 'Đã lưu (' + KEY_FIELDS.filter(k => keys[k]).length + '/' + KEY_FIELDS.length + ' ô có giá trị).';
  });

  // ---------- persist ----------
  async function save() { await store.set('rbl_runs', runs); await store.set('rbl_selected', selected); }
  async function load() {
    runs = (await store.get('rbl_runs')) || [];
    selected = (await store.get('rbl_selected')) || {};
    const form = (await store.get('rbl_form')) || {};
    if (form.q) $('#q').value = form.q;
    if (form.seeds) $('#seeds').value = form.seeds;
    updateBadge();
  }
  const saveForm = () => store.set('rbl_form', { q: $('#q').value, seeds: $('#seeds').value });
  $('#q').addEventListener('change', saveForm);
  $('#seeds').addEventListener('change', saveForm);

  // ---------- helpers ----------
  const num = (id, d) => { const v = Number($(id).value); return Number.isFinite(v) && v > 0 ? v : d; };
  function setBusy(b) {
    $('#btnRun').disabled = b; $('#btnSnow').disabled = b;
    $('#btnStop').disabled = !b; $('#btnStop2').disabled = !b;
  }
  $('#btnStop').addEventListener('click', () => { stopFlag.stop = true; log('⏹ Đang dừng…'); });
  $('#btnStop2').addEventListener('click', () => { stopFlag.stop = true; log('⏹ Đang dừng…'); });
  const parseXML = x => new DOMParser().parseFromString(x, 'application/xml');

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- preview ----------
  $('#btnPreview').addEventListener('click', () => {
    const box = $('#previewBox');
    box.classList.remove('hidden');
    try {
      const pv = Sources.preview($('#q').value, { lineCap: num('#lineCap', 30) });
      box.innerHTML = Object.entries(pv).map(([k, v]) => `<div><b>${esc(k)}</b><pre>${esc(v)}</pre></div>`).join('');
    } catch (e) { box.innerHTML = `<div><b>Lỗi chuỗi tìm</b><pre>${esc(e.message)}</pre></div>`; }
  });

  // ---------- run search ----------
  $('#btnRun').addEventListener('click', async () => {
    const query = $('#q').value.trim();
    const sources = $$('.src').filter(c => c.checked).map(c => c.value);
    const label = $('#runLabel').value.trim() || 'V?';
    if (!query) return alertBox('Chưa nhập chuỗi tìm.');
    if (!sources.length) return alertBox('Chưa chọn nguồn nào.');
    try { Core.parse(query); } catch (e) { return alertBox('Chuỗi tìm lỗi: ' + e.message); }
    if (runs.some(r => r.label === label) && !confirm(`Nhãn "${label}" đã dùng. Vẫn chạy với cùng nhãn?`)) return;
    saveForm();
    stopFlag.stop = false; setBusy(true);
    log(`=== Search ${label} · nguồn: ${sources.join(', ')}`);
    try {
      const run = await Sources.runSearch({
        query, sources, keys, log, stopFlag, parseXML, label,
        opt: { yearFrom: num('#yearFrom', 0), max: num('#max', 500), oaField: $('#oaField').value,
          perLine: num('#perLine', 20), lineCap: num('#lineCap', 30), scholarPages: num('#scholarPages', 3) },
      });
      for (const r of run.records) { const k = recKey(r); if (!(k in selected)) selected[k] = true; }
      runs.push(run);
      await save();
      const errs = run.sources.filter(s => s.error);
      log(`=== Xong ${label}: ${run.records.length} bản ghi thô từ ${run.sources.length} nguồn${errs.length ? ` · ⚠ ${errs.length} nguồn lỗi: ` + errs.map(s => s.name).join(', ') : ''}`);
    } catch (e) { log('✖ ' + e.message); }
    setBusy(false); updateBadge();
  });

  // ---------- run snowball ----------
  $('#btnSnow').addEventListener('click', async () => {
    const seeds = $('#seeds').value.split(/\s+/).map(s => s.trim()).filter(Boolean);
    const directions = $$('.dir').filter(c => c.checked).map(c => c.value);
    const via = $$('.via').filter(c => c.checked).map(c => c.value);
    if (!seeds.length) return alertBox('Chưa nhập DOI seed.');
    if (!directions.length || !via.length) return alertBox('Chọn ít nhất 1 hướng và 1 API.');
    saveForm();
    const label = $('#snowLabel').value.trim() || 'SB';
    stopFlag.stop = false; setBusy(true);
    log(`=== Snowballing ${label} · ${seeds.length} seed`);
    try {
      const run = await Sources.runSnowball({
        seeds, directions, via, keys, log, stopFlag, label, round: $('#round').value,
        opt: { yearFrom: num('#snowYear', 0), max: num('#snowMax', 500) },
      });
      for (const r of run.records) { const k = recKey(r); if (!(k in selected)) selected[k] = false; }
      runs.push(run);
      await save();
      log(`=== Xong ${label}: ${run.records.length} bản ghi (chưa tick — vào tab 3 lướt tiêu đề và tick bài liên quan)`);
    } catch (e) { log('✖ ' + e.message); }
    setBusy(false); updateBadge();
  });

  // ---------- results ----------
  function pool() { return Core.dedup(runs.flatMap(r => r.records)); }
  function updateBadge() { $('#badge').textContent = pool().after; }

  function render() {
    const d = pool();
    const f = $('#filter').value.trim().toLowerCase();
    const rows = d.records.filter(r => !f || [r.title, r.source, r.run, r.doi, r.snowball].join(' ').toLowerCase().includes(f));
    const sel = d.records.filter(r => selected[recKey(r)]).length;
    $('#stats').innerHTML = `<span>Lượt chạy: <b>${runs.length}</b></span><span>Trước dedup: <b>${d.before}</b></span>`
      + `<span>Sau dedup: <b>${d.after}</b></span><span>Bỏ trùng: <b>${d.removed}</b></span><span>Đã tick (sẽ xuất): <b>${sel}</b></span>`
      + (f ? `<span>Đang hiện: <b>${rows.length}</b></span>` : '');
    const tb = $('#tbl tbody');
    tb.innerHTML = rows.slice(0, 2000).map(r => {
      const k = recKey(r); const on = !!selected[k];
      const link = r.url || (r.doi ? 'https://doi.org/' + r.doi : '');
      return `<tr class="${on ? '' : 'off'}"><td><input type="checkbox" data-k="${esc(k)}" ${on ? 'checked' : ''}></td>`
        + `<td>${esc(r.year)}</td><td class="t">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}`
        + `<div class="ab">${esc(r.venue)}${r.abstract ? ' — ' + esc(r.abstract) : ''}</div></td>`
        + `<td>${esc(r.source)}</td><td>${esc(r.run)}</td><td>${esc(r.doi)}</td><td>${esc(r.language)}</td>`
        + `<td>${esc(r.snowball)}${r.seed ? '<div class="muted small">seed: ' + esc(r.seed) + '</div>' : ''}</td></tr>`;
    }).join('') + (rows.length > 2000 ? `<tr><td colspan="8" class="muted">… chỉ hiện 2000 dòng đầu, dùng ô lọc để thu hẹp</td></tr>` : '');
  }
  $('#filter').addEventListener('input', render);
  $('#tbl').addEventListener('change', async e => {
    if (e.target.matches('input[type=checkbox]')) {
      selected[e.target.dataset.k] = e.target.checked;
      e.target.closest('tr').classList.toggle('off', !e.target.checked);
      await save();
      const d = pool();
      $('#stats').querySelectorAll('b')[4].textContent = d.records.filter(r => selected[recKey(r)]).length;
    }
  });
  async function setVisible(v) {
    $$('#tbl tbody input[type=checkbox]').forEach(c => { c.checked = v; selected[c.dataset.k] = v; });
    await save(); render();
  }
  $('#selAll').addEventListener('click', () => setVisible(true));
  $('#selNone').addEventListener('click', () => setVisible(false));

  // ---------- export ----------
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  $('#btnCsv').addEventListener('click', () => {
    const d = pool();
    const rows = d.records.filter(r => selected[recKey(r)]);
    if (!rows.length) return alertBox('Chưa tick bài nào.');
    download(`01_all_records_${stamp()}.csv`, Core.toCSV(rows, { prefix: $('#prefix').value.trim() || 'K', start: num('#startNo', 1) }), 'text/csv;charset=utf-8');
    log(`⬇ Xuất CSV: ${rows.length} bản ghi`);
  });

  $('#btnLog').addEventListener('click', () => {
    const d = pool();
    const chosen = d.records.filter(r => selected[recKey(r)]);
    // "Số thêm vào 01" cho từng seed/hướng = số bài đã tick có cùng seed + hướng
    const annotated = runs.map(run => run.kind !== 'snowball' ? run : Object.assign({}, run, {
      sources: run.sources.map(s => {
        const tag = s.direction === 'lùi' ? 'snowball-back' : 'snowball-fwd';
        const added = chosen.filter(r => (r.seed || '').split(';').includes(s.seed) && (r.snowball || '').split(';').includes(tag)).length;
        return Object.assign({}, s, { added });
      }),
    }));
    download(`search-log_harvester_${stamp()}.md`, Core.searchLogMarkdown(annotated, { before: d.before, after: d.after, removed: d.removed, selected: chosen.length }), 'text/markdown;charset=utf-8');
    log('⬇ Xuất đoạn search-log');
  });

  $('#btnRaw').addEventListener('click', () => {
    download(`raw_harvester_${stamp()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), runs }, null, 2), 'application/json');
  });

  $('#btnClear').addEventListener('click', async () => {
    if (!confirm('Xoá toàn bộ kết quả các lượt chạy? (Nên xuất CSV/log/json trước.)')) return;
    runs = []; selected = {}; await save(); render(); updateBadge(); log('🗑 Đã xoá kết quả');
  });
  $('#btnClearLog').addEventListener('click', () => { $('#log').textContent = ''; });
  $('#btnLastReq').addEventListener('click', () => {
    const r = Sources.lastRequests[0];
    if (!r) return alertBox('Chưa có request nào. Chạy search trước.');
    window.open(r.url, '_blank'); // URL đầy đủ (có key) chỉ mở trong trình duyệt của bạn, không ghi vào log
  });

  function alertBox(m) { log('⚠ ' + m); alert(m); }

  loadKeys().then(load).then(() => log(hasChrome ? 'Sẵn sàng.' : 'Đang chạy ngoài extension — chỉ để xem giao diện (gọi API sẽ bị chặn CORS).'));
})();
