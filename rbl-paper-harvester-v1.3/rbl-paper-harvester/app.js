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
    // dữ liệu cào bằng bản ≤1.1: bản ghi Google Scholar chưa có cờ snippet → đánh dấu để bổ sung abstract thật
    let mig = 0;
    for (const run of runs) for (const r of run.records || []) {
      if (r.snippet === undefined && /google scholar/i.test(r.source || '') && !r.enriched) { r.snippet = true; mig++; }
    }
    if (mig) { await store.set('rbl_runs', runs); log(`Đã đánh dấu ${mig} bản ghi Google Scholar cũ là "chỉ có đoạn trích" để bổ sung abstract.`); }
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

  // ---------- ACM DL: mở trang tìm + nhập file BibTeX export ----------
  $('#btnAcmOpen').addEventListener('click', () => {
    const q = $('#q').value.trim();
    if (!q) return alertBox('Chưa nhập chuỗi tìm.');
    let s; try { s = Core.translate.boolean(Core.parse(q)); } catch (e) { return alertBox('Chuỗi tìm lỗi: ' + e.message); }
    const p = new URLSearchParams({ AllField: s, pageSize: '50' });
    const y = num('#yearFrom', 0); if (y) p.set('AfterYear', String(y));
    window.open('https://dl.acm.org/action/doSearch?' + p.toString(), '_blank');
    if (!$('#acmQuery').value) $('#acmQuery').value = s;
    log('↗ Đã mở ACM DL (AllField = mọi trường). Nếu PL dùng trường Abstract/Title thì chỉnh trong Advanced Search của ACM và ghi lại chuỗi thật vào ô "Chuỗi đã dùng trên ACM".');
  });
  $('#btnAcmImport').addEventListener('click', async () => {
    const files = [...($('#acmFile').files || [])];
    if (!files.length) return alertBox('Chưa chọn file .bib export từ ACM.');
    const label = $('#runLabel').value.trim() || 'ACM?';
    if (runs.some(r => r.label === label) && !confirm(`Nhãn "${label}" đã dùng. Vẫn nhập với cùng nhãn?`)) return;
    const when = Sources.nowStamp();
    const qText = $('#acmQuery').value.trim() || $('#q').value.trim() || '(chưa ghi chuỗi đã dùng trên ACM)';
    const base = { run: label, fetchedAt: when, query: qText };
    let entries = [];
    for (const f of files) {
      const txt = await f.text();
      const e = Core.parseBibTeX(txt);
      log(`ACM: ${f.name} → ${e.length} mục BibTeX`);
      entries = entries.concat(e);
    }
    if (!entries.length) return alertBox('Không đọc được mục BibTeX nào. Hãy chắc là file export dạng BibTeX từ ACM.');
    const records = Core.bibToRecords(entries, base).filter(r => r.title);
    const y = num('#yearFrom', 0);
    const old = y ? records.filter(r => Number(r.year) && Number(r.year) < y).length : 0;
    const reported = $('#acmReported').value === '' ? null : Number($('#acmReported').value);
    const noAbs = records.filter(r => !r.abstract).length;
    const notes = [`nhập từ ${files.length} file BibTeX (${files.map(f => f.name).join(', ')}): ${entries.length} mục`];
    if (reported !== null && reported !== records.length) notes.push(`⚠ lệch: ACM báo ${reported}, file có ${records.length} → giải thích trong log (vd export thiếu trang)`);
    if (old) notes.push(`${old} bài trước năm ${y} (kiểm tra bộ lọc năm trên ACM)`);
    if (noAbs) notes.push(`${noAbs} mục không có abstract trong file`);
    const run = { kind: 'search', label, when, query: qText, records,
      sources: [{ name: 'ACM DL (export web)', field: 'theo cài đặt trên web ACM', filters: y ? `AfterYear = ${y} (đặt trên web)` : 'không',
        sent: [qText], reported, fetched: records.length, notes, error: '' }] };
    for (const r of records) { const k = recKey(r); if (!(k in selected)) selected[k] = true; }
    runs.push(run); await save(); updateBadge();
    log(`=== Nhập ACM ${label}: ${records.length} bản ghi${reported !== null ? ` (ACM báo ${reported})` : ''}. Sang tab 3 để xem.`);
    $('#acmFile').value = '';
  });

  // ---------- results ----------
  function pool() { return Core.dedup(runs.flatMap(r => r.records)); }
  function updateBadge() { $('#badge').textContent = pool().after; }
  const FLAG_CLASS = { 'ƯU TIÊN': 'f1', 'XEM': 'f2', 'THIẾU ABSTRACT': 'f3', 'ÍT KHẢ NĂNG': 'f4', 'LOẠI?': 'f5' };
  const screenOf = r => Core.screen(r, { yearFrom: num('#yearFrom', 0) });

  // tô sáng từ khoá P/I/O trong văn bản (đã escape)
  function highlight(text, sc) {
    const terms = [...sc.found.P, ...sc.found.I, ...sc.found.O].filter(Boolean);
    if (!terms.length || !text) return esc(text);
    const rx = new RegExp('(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+')).join('|') + ')', 'gi');
    let out = '', last = 0, m;
    while ((m = rx.exec(text))) { out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; if (m[0].length === 0) rx.lastIndex++; }
    return out + esc(text.slice(last));
  }

  function render() {
    const d = pool();
    const f = $('#filter').value.trim().toLowerCase();
    const ff = $('#flagFilter').value;
    const scr = new Map(d.records.map(r => [r, screenOf(r)]));
    const rows = d.records.filter(r => (!f || [r.title, r.source, r.run, r.doi, r.snowball].join(' ').toLowerCase().includes(f)) && (!ff || scr.get(r).flag === ff));
    const sel = d.records.filter(r => selected[recKey(r)]).length;
    $('#stats').innerHTML = `<span>Lượt chạy: <b>${runs.length}</b></span><span>Trước dedup: <b>${d.before}</b></span>`
      + `<span>Sau dedup: <b>${d.after}</b></span><span>Bỏ trùng: <b>${d.removed}</b></span><span>Đã tick (sẽ xuất): <b>${sel}</b></span>`
      + (f || ff ? `<span>Đang hiện: <b>${rows.length}</b></span>` : '');
    const cnt = {}; for (const sc of scr.values()) cnt[sc.flag] = (cnt[sc.flag] || 0) + 1;
    const noAbs = d.records.filter(r => !scr.get(r).hasAbs).length;
    $('#flagStats').innerHTML = Core.FLAGS.map(k => `<span class="fl ${FLAG_CLASS[k]}">${k}: ${cnt[k] || 0}</span>`).join('')
      + `<span class="muted small">· chưa có abstract đầy đủ: ${noAbs}/${d.after} · chưa có DOI: ${d.records.filter(r => !r.doi).length}/${d.after}</span>`;
    const tb = $('#tbl tbody');
    tb.innerHTML = rows.slice(0, 2000).map(r => {
      const k = recKey(r); const on = !!selected[k]; const sc = scr.get(r);
      const link = r.url || (r.doi ? 'https://doi.org/' + r.doi : '');
      const why = [Core.matchedTerms(sc), sc.reasons.join('; '), sc.notes.join('; ')].filter(Boolean).join(' | ');
      return `<tr class="${on ? '' : 'off'}"><td><input type="checkbox" data-k="${esc(k)}" ${on ? 'checked' : ''}></td>`
        + `<td>${esc(r.year)}</td><td class="t">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${highlight(r.title, sc)}</a>` : highlight(r.title, sc)}`
        + `<div class="ab" title="bấm để mở rộng/thu gọn">${esc(r.venue)}${r.abstract ? ' — ' + highlight(r.abstract, sc) : ''}</div></td>`
        + `<td>${esc(r.source)}</td><td>${esc(r.run)}</td><td>${esc(r.doi)}</td><td>${esc(r.language)}</td>`
        + `<td>${esc(r.snowball)}${r.seed ? '<div class="muted small">seed: ' + esc(r.seed) + '</div>' : ''}</td>`
        + `<td class="g"><span class="fl ${FLAG_CLASS[sc.flag]}">${sc.flag}</span><div class="why">${esc(why)}</div></td></tr>`;
    }).join('') + (rows.length > 2000 ? `<tr><td colspan="9" class="muted">… chỉ hiện 2000 dòng đầu, dùng ô lọc để thu hẹp</td></tr>` : '');
  }
  $('#flagFilter').addEventListener('change', render);
  $('#tbl').addEventListener('click', e => { const ab = e.target.closest('.ab'); if (ab) ab.classList.toggle('open'); });

  // Chỉ tick bài ƯU TIÊN + XEM (bài khác bỏ tick). Chỉ là bước lọc thô để đọc trước.
  $('#btnTickSuggest').addEventListener('click', async () => {
    const d = pool(); let on = 0, off = 0;
    for (const r of d.records) { const f = screenOf(r).flag; const v = f === 'ƯU TIÊN' || f === 'XEM'; selected[recKey(r)] = v; v ? on++ : off++; }
    await save(); render();
    log(`☑ Tick theo gợi ý: ${on} bài (ƯU TIÊN + XEM), bỏ tick ${off} bài. Bài THIẾU ABSTRACT chưa được tick: hãy bấm "Bổ sung abstract" rồi tick lại.`);
  });

  // Khoá bản ghi đổi khi vừa có DOI → chuyển trạng thái tick sang khoá mới
  function migrateKeys(raw, oldKeys) {
    for (const r of raw) { const o = oldKeys.get(r), n = recKey(r); if (o !== n && !(n in selected) && o in selected) selected[n] = selected[o]; }
  }

  // Bổ sung abstract + DOI: link → OpenAlex (DOI/tiêu đề) → Crossref (tiêu đề)
  $('#btnEnrich').addEventListener('click', async () => {
    const raw = runs.flatMap(r => r.records);
    const oldKeys = new Map(raw.map(r => [r, recKey(r)]));
    stopFlag.stop = false; setBusy(true); $('#btnEnrich').disabled = true;
    log(`=== Bổ sung abstract + DOI cho ${raw.filter(r => !r.doi || r.snippet || (r.abstract || '').length < 80).length} bản ghi thiếu (bản đã thử sẽ bỏ qua)`);
    const st = await Sources.enrichAbstracts({ records: raw, keys, log, stopFlag, max: 800 });
    migrateKeys(raw, oldKeys); await save();
    log(`=== Xong: DOI lấy từ link ${st.doiFromUrl} · DOI mới qua OpenAlex/Crossref ${st.gotDoi} (Crossref ${st.crossrefDoi}) · abstract mới ${st.foundAbs}`
      + ` · còn thiếu DOI ${st.stillNoDoi} · còn thiếu abstract ${st.stillNoAbs}`
      + (st.stoppedEarly ? ` · ⚠ dừng giữa chừng${st.errors.length ? ': ' + st.errors[0] : ''} (bấm lại để chạy tiếp)` : ''));
    $('#btnEnrich').disabled = false; setBusy(false); updateBadge(); render();
  });

  // Mở từng trang bài để đọc DOI (thẻ meta citation_doi…). Cần quyền đọc trang web → xin khi bấm.
  $('#btnPageDoi').addEventListener('click', async () => {
    const raw = runs.flatMap(r => r.records);
    const n = raw.filter(r => !r.doi && !r.pageTried && /^https?:/.test(r.url || '')).length;
    if (!n) return alertBox('Không còn bài nào thiếu DOI có link để mở (hoặc đã thử hết). Nên bấm "Bổ sung abstract + DOI" trước.');
    if (hasChrome && chrome.permissions) {
      const ok = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }).catch(() => false);
      if (!ok) return alertBox('Chưa cấp quyền đọc trang web nên không mở được trang bài.');
    }
    if (!confirm(`Sẽ mở lần lượt tối đa 150/${n} trang bài (~1,5 s/trang, khoảng ${Math.ceil(Math.min(n, 150) * 1.8 / 60)} phút). Bỏ qua dl.acm.org, Google Books, ResearchGate, Academia, file PDF. Tiếp tục?`)) return;
    const oldKeys = new Map(raw.map(r => [r, recKey(r)]));
    stopFlag.stop = false; setBusy(true); $('#btnPageDoi').disabled = true;
    log(`=== Mở trang bài để tìm DOI: ${Math.min(n, 150)} bài`);
    const st = await Sources.doiFromPages({ records: raw, log, stopFlag, max: 150 });
    migrateKeys(raw, oldKeys); await save();
    log(`=== Xong: đã mở ${st.tried} trang · tìm được DOI ${st.found} · bị chặn/lỗi ${st.blocked} · bỏ qua ${st.skipped}. Bài vừa có DOI: bấm "Bổ sung abstract + DOI" để lấy abstract.`);
    for (const r of raw) if (r.doi && r.enriched && r.enriched.includes('trang bài') && (r.snippet || (r.abstract || '').length < 80)) r.enrichTried = '';
    await save();
    $('#btnPageDoi').disabled = false; setBusy(false); updateBadge(); render();
  });

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
    download(`01_all_records_${stamp()}.csv`, Core.toCSV(rows, { prefix: $('#prefix').value.trim() || 'K', start: num('#startNo', 1), yearFrom: num('#yearFrom', 0) }), 'text/csv;charset=utf-8');
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
