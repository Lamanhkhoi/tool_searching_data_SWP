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
  let selected = {};      // key bản ghi → true/false (true = bài nằm trong 01)
  let screen = {};        // key → { v1, v1r:[], v1n, v2, v2r:[], v2n }
  let codes = {};         // key → mã K cố định
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
    if (b.dataset.tab === 'screen') renderScreen();
    if (b.dataset.tab === 'prisma') renderPrisma();
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
  async function save() { await store.set('rbl_runs', runs); await store.set('rbl_selected', selected); await store.set('rbl_screen', screen); await store.set('rbl_codes', codes); }
  let saveTimer = null;
  const saveScreenSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { store.set('rbl_screen', screen); store.set('rbl_codes', codes); }, 300); };
  async function load() {
    runs = (await store.get('rbl_runs')) || [];
    selected = (await store.get('rbl_selected')) || {};
    screen = (await store.get('rbl_screen')) || {};
    codes = (await store.get('rbl_codes')) || {};
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
      for (const r of run.records) { const k = recKey(r); if (!(k in selected)) selected[k] = true; }
      runs.push(run);
      await save();
      const errs = run.sources.filter(x => x.error);
      log(`=== Xong ${label} (vòng ${run.round}): ${run.records.length} bản ghi (lùi ${run.records.filter(r => r.snowball === 'snowball-back').length}, tiến ${run.records.filter(r => r.snowball === 'snowball-fwd').length}). Đã đưa vào 01 → sang tab 4 screening V1.`
        + (errs.length ? ` ⚠ ${errs.length} lỗi: ` + errs.map(x => x.name + ' ' + x.seed + ': ' + x.error).join(' | ') : ''));
    } catch (e) { log('✖ ' + e.message); }
    setBusy(false); updateBadge();
  });

  // ---------- seed tự động từ INCLUDE (V2) ----------
  $('#round').addEventListener('change', () => { $('#snowLabel').value = 'SB' + $('#round').value; });
  function fillSeeds(round) {
    const m = model();
    const sd = Prisma.seedsFor(round, m, selected, screen);
    const ok = sd.seeds.filter(x => x.id), noId = sd.seeds.filter(x => !x.id);
    const pendTxt = sd.pending ? ` · ⚠ còn ${sd.pending} bài của ${round === 2 ? 'vòng 1' : 'nhánh CSDL'} chưa quyết xong V1/V2 nên danh sách seed có thể chưa đủ` : '';
    if (!ok.length) {
      $('#seedInfo').textContent = `Chưa có bài INCLUDE (V2) nào ${round === 2 ? 'ở snowballing vòng 1' : 'ở nhánh CSDL'} để làm seed${pendTxt}.`;
      return alertBox($('#seedInfo').textContent);
    }
    $('#seeds').value = ok.map(x => x.id).join('\n');
    $('#round').value = String(round); $('#snowLabel').value = 'SB' + round;
    $('#seedInfo').textContent = `Vòng ${round}: ${ok.length} seed (${ok.map(x => x.code).join(', ')})${noId.length ? ` · ${noId.length} bài không có DOI/mã OpenAlex nên bỏ qua: ${noId.map(x => x.code).join(', ')}` : ''}${pendTxt}`;
    saveForm();
  }
  $('#btnSeed1').addEventListener('click', () => fillSeeds(1));
  $('#btnSeed2').addEventListener('click', () => fillSeeds(2));

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
  function model() {
    const m = Prisma.merge(runs);
    if (Prisma.ensureCodes(m.records, selected, screen, codes, { prefix: $('#prefix').value.trim() || 'K', start: num('#startNo', 1) })) saveScreenSoon();
    m.removed = m.before - m.after;
    return m;
  }
  const pool = model;
  function updateBadge() {
    const m = model();
    $('#badge').textContent = m.after;
    const in01 = m.records.filter(r => selected[r.key] && r.code);
    const pend = in01.filter(r => !Prisma.v1Of(screen, r)).length + in01.filter(r => ['INCLUDE', 'Unsure'].includes(Prisma.v1Of(screen, r)) && !Prisma.v2Of(screen, r)).length;
    $('#badgeScreen').textContent = pend;
  }
  const STAGE_SHORT = { db: 'CSDL', other: 'Nguồn bổ sung', sb1: 'SB vòng 1', sb2: 'SB vòng 2' };
  function codeMap(m) {
    const mp = new Map();
    for (const r of m.records) if (r.code) { if (r.doi) mp.set(r.doi, r.code); if (r.ids && r.ids.openalex) mp.set(String(r.ids.openalex).toUpperCase(), r.code); }
    return mp;
  }
  function chipsHtml(r, cmap) {
    let h = `<span class="chip ${r.stage}">${STAGE_SHORT[r.stage] || ''}</span>`;
    const tags = String(r.snowball || '').split(';');
    if (tags.includes('snowball-back')) h += '<span class="chip back" title="Bài này nằm trong danh sách tài liệu tham khảo (references) của seed">← LÙI</span>';
    if (tags.includes('snowball-fwd')) h += '<span class="chip fwd" title="Bài này trích dẫn (cite) seed">→ TIẾN</span>';
    const seeds = String(r.seed || '').split(';').filter(Boolean).map(x => cmap.get(x) || cmap.get(x.toUpperCase()) || x);
    if (seeds.length) h += `<div class="muted small">seed: ${esc(seeds.join(', '))}</div>`;
    return h;
  }
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
    const df = $('#dirFilter').value;
    const cmap = codeMap(d);
    const dirOk = r => !df || (df === 'back' ? /snowball-back/.test(r.snowball) : df === 'fwd' ? /snowball-fwd/.test(r.snowball) : r.stage === df);
    const rows = d.records.filter(r => (!f || [r.title, r.source, r.run, r.doi, r.snowball, r.code].join(' ').toLowerCase().includes(f)) && (!ff || scr.get(r).flag === ff) && dirOk(r));
    const sel = d.records.filter(r => selected[recKey(r)]).length;
    $('#stats').innerHTML = `<span>Lượt chạy: <b>${runs.length}</b></span><span>Trước dedup: <b>${d.before}</b></span>`
      + `<span>Sau dedup: <b>${d.after}</b></span><span>Bỏ trùng: <b>${d.removed}</b></span><span>Đã tick (sẽ xuất): <b>${sel}</b></span>`
      + (f || ff || df ? `<span>Đang hiện: <b>${rows.length}</b></span>` : '');
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
        + `<td>${esc(r.year)}${r.code ? '<div class="muted small">' + esc(r.code) + '</div>' : ''}</td><td class="t">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${highlight(r.title, sc)}</a>` : highlight(r.title, sc)}`
        + `<div class="ab" title="bấm để mở rộng/thu gọn">${esc(r.venue)}${r.abstract ? ' — ' + highlight(r.abstract, sc) : ''}</div></td>`
        + `<td>${esc(r.source)}</td><td>${esc(r.run)}</td><td>${esc(r.doi)}</td><td>${esc(r.language)}</td>`
        + `<td>${chipsHtml(r, cmap)}</td>`
        + `<td class="g"><span class="fl ${FLAG_CLASS[sc.flag]}">${sc.flag}</span><div class="why">${esc(why)}</div></td></tr>`;
    }).join('') + (rows.length > 2000 ? `<tr><td colspan="9" class="muted">… chỉ hiện 2000 dòng đầu, dùng ô lọc để thu hẹp</td></tr>` : '');
  }
  $('#flagFilter').addEventListener('change', render);
  $('#dirFilter').addEventListener('change', render);
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
    for (const r of raw) {
      const o = oldKeys.get(r), n = recKey(r);
      if (o === n) continue;
      if (!(n in selected) && o in selected) selected[n] = selected[o];
      if (!(n in screen) && o in screen) { screen[n] = screen[o]; delete screen[o]; }
      if (!(n in codes) && o in codes) { codes[n] = codes[o]; delete codes[o]; }
    }
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
      $('#stats').querySelectorAll('b')[4].textContent = d.records.filter(r => selected[r.key]).length;
      updateBadge();
    }
  });
  async function setVisible(v) {
    $$('#tbl tbody input[type=checkbox]').forEach(c => { c.checked = v; selected[c.dataset.k] = v; });
    await save(); render(); updateBadge();
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
    const rows = d.records.filter(r => selected[r.key] && r.code);
    if (!rows.length) return alertBox('Chưa tick bài nào.');
    download('01_all_records.csv', Prisma.csv01(d, selected), 'text/csv;charset=utf-8');
    log(`⬇ Xuất 01_all_records.csv: ${rows.length} bản ghi`);
  });

  $('#btnLog').addEventListener('click', () => {
    const d = pool();
    const chosen = d.records.filter(r => selected[r.key]);
    const annotated = Prisma.annotateRuns(runs, d, selected, screen);
    download(`search-log_harvester_${stamp()}.md`, Core.searchLogMarkdown(annotated, { before: d.before, after: d.after, removed: d.removed, selected: chosen.length }), 'text/markdown;charset=utf-8');
    log('⬇ Xuất đoạn search-log');
  });

  $('#btnRaw').addEventListener('click', () => {
    download(`raw_harvester_${stamp()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), runs }, null, 2), 'application/json');
  });

  $('#btnClear').addEventListener('click', async () => {
    if (!confirm('Xoá toàn bộ kết quả các lượt chạy? (Nên xuất CSV/log/json trước.)')) return;
    runs = []; selected = {}; screen = {}; codes = {}; await save(); render(); updateBadge(); log('🗑 Đã xoá kết quả, trạng thái screening và mã K');
  });
  $('#btnClearLog').addEventListener('click', () => { $('#log').textContent = ''; });
  $('#btnLastReq').addEventListener('click', () => {
    const r = Sources.lastRequests[0];
    if (!r) return alertBox('Chưa có request nào. Chạy search trước.');
    window.open(r.url, '_blank'); // URL đầy đủ (có key) chỉ mở trong trình duyệt của bạn, không ghi vào log
  });

  // ---------- SCREENING V1/V2 ----------
  const codeNum = c => Number(String(c || '').replace(/\D+/g, '')) || 0;
  let scRows = new Map();
  const stg = () => $('#scStage').value;            // 'v1' | 'v2'
  const decOf = r => stg() === 'v1' ? Prisma.v1Of(screen, r) : Prisma.v2Of(screen, r);
  function suggestCodes(sc) {
    const s = [];
    for (const x of sc.reasons) { const mm = x.match(/^(IC-L|IC-Y|EC-S)/); if (mm) s.push(mm[1]); }
    if (!sc.found.P.length) s.push('IC-P');
    if (!sc.found.I.length) s.push('IC-I');
    if (sc.found.O.length) s.push('EC-O');
    return new Set(s);
  }
  function cardHtml(r, cmap) {
    const st = stg(), d = screen[r.key] || {}, cur = decOf(r);
    const rs = d[st + 'r'] || [];
    const sc = screenOf(r), sug = suggestCodes(sc);
    const link = r.doi ? 'https://doi.org/' + r.doi : (r.url || '');
    const opts = st === 'v1' ? ['INCLUDE', 'EXCLUDE', 'Unsure'] : ['INCLUDE', 'EXCLUDE'];
    const v1info = st === 'v2' ? `<div class="muted small">V1: ${esc(d.v1)}${(d.v1r || []).length ? ' (' + esc(d.v1r.join('; ')) + ')' : ''}${d.v1n ? ' — ' + esc(d.v1n) : ''}</div>` : '';
    return `<div class="card d-${cur || 'none'}" data-k="${esc(r.key)}">`
      + `<div class="hd"><span class="code">${esc(r.code)}</span><span>${esc(r.year)}</span>${chipsHtml(r, cmap)}<span class="fl ${FLAG_CLASS[sc.flag]}">${sc.flag}</span><span class="muted">${esc(r.venue)}</span></div>`
      + `<div class="ttl">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${highlight(r.title, sc)}</a>` : highlight(r.title, sc)}</div>`
      + v1info
      + ((r.numpages || r.oaUrl) ? `<div class="muted small">${r.numpages ? 'số trang: <b>' + esc(r.numpages) + '</b>' + (Number(r.numpages) < 4 ? ' ⚠ EC-S' : '') : 'số trang: ?'}${r.oaUrl ? ' · <a href="' + esc(r.oaUrl) + '" target="_blank" rel="noopener">toàn văn mở (PDF/OA)</a>' : ''}</div>` : '')
      + `<div class="abs">${r.abstract ? highlight(r.abstract, sc) : '<i class="muted">(không có abstract — mở link để đọc)</i>'}</div>`
      + `<div class="acts">${opts.map(o => `<button class="dbtn ${o} ${cur === o ? 'on' : ''}" data-act="dec" data-v="${o}">${o}</button>`).join('')}`
      + `<span class="muted small">mã lý do:</span>${Prisma.CODES.map(c => `<button class="rc ${rs.includes(c) ? 'on' : ''} ${rs[0] === c ? 'first' : ''} ${sug.has(c) && !rs.includes(c) ? 'sug' : ''}" data-act="rc" data-v="${c}" title="${esc(Prisma.CODE_DESC[c])}">${c}</button>`).join('')}`
      + `<input class="note" data-act="note" placeholder="ghi chú ${st.toUpperCase()} (vd: lý do, trang có EP/BVA…)" value="${esc(d[st + 'n'] || '')}"></div></div>`;
  }
  function scProgress(m) {
    const st = stg(), br = $('#scBranch').value;
    const in01 = m.records.filter(r => selected[r.key] && r.code && (!br || r.stage === br));
    const base = st === 'v1' ? in01 : in01.filter(r => ['INCLUDE', 'Unsure'].includes(Prisma.v1Of(screen, r)));
    const c = { INCLUDE: 0, EXCLUDE: 0, Unsure: 0, '': 0 };
    for (const r of base) c[decOf(r)]++;
    $('#scProgress').innerHTML = `<span>${st.toUpperCase()}: <b>${base.length - c['']}</b>/${base.length} đã quyết</span><span>INCLUDE <b>${c.INCLUDE}</b></span><span>EXCLUDE <b>${c.EXCLUDE}</b></span>${st === 'v1' ? `<span>Unsure <b>${c.Unsure}</b></span>` : ''}<span>Chưa quyết <b>${c['']}</b></span>`;
  }
  function renderScreen() {
    const m = model(), st = stg(), br = $('#scBranch').value, stt = $('#scStatus').value, q = $('#scFind').value.trim().toLowerCase();
    const cmap = codeMap(m);
    const in01 = m.records.filter(r => selected[r.key] && r.code);
    let rows = (st === 'v1' ? in01 : in01.filter(r => ['INCLUDE', 'Unsure'].includes(Prisma.v1Of(screen, r))))
      .filter(r => !br || r.stage === br).filter(r => !q || (r.code + ' ' + r.title).toLowerCase().includes(q));
    if (stt === 'todo') rows = rows.filter(r => !decOf(r));
    else if (stt === 'noreason') rows = rows.filter(r => decOf(r) === 'EXCLUDE' && !((screen[r.key] || {})[st + 'r'] || []).length);
    else if (stt === 'auto') rows = rows.filter(r => String((screen[r.key] || {})[st + 'n'] || '').startsWith(AUTO_TAG));
    else if (stt !== 'all') rows = rows.filter(r => decOf(r) === stt);
    rows.sort((a, b) => codeNum(a.code) - codeNum(b.code));
    scRows = new Map(rows.map(r => [r.key, r]));
    scProgress(m);
    $('#scList').innerHTML = rows.length ? rows.slice(0, 300).map(r => cardHtml(r, cmap)).join('') + (rows.length > 300 ? '<p class="muted">… hiện 300 bài đầu, quyết xong sẽ hiện tiếp</p>' : '')
      : `<p class="muted">Không có bài nào ở bộ lọc này.${st === 'v2' ? ' V2 chỉ gồm bài INCLUDE/Unsure ở V1.' : ''}${!in01.length ? ' Chưa có bài nào trong 01: chạy search ở tab 1 trước.' : ''}</p>`;
  }
  ['#scStage', '#scBranch', '#scStatus'].forEach(id => $(id).addEventListener('change', renderScreen));

  // ----- Sàng V1 tự động theo luật: chỉ bài CHƯA quyết; ghi luật vào ghi chú để rà lại -----
  const AUTO_TAG = '[tự động] ', REVIEWED_TAG = '[tự động, đã rà] ';
  $('#btnAutoV1').addEventListener('click', async () => {
    if (stg() !== 'v1') { $('#scStage').value = 'v1'; }
    const m = model(), br = $('#scBranch').value;
    const rows = m.records.filter(r => selected[r.key] && r.code && (!br || r.stage === br) && !Prisma.v1Of(screen, r));
    if (!rows.length) return alertBox('Không còn bài nào chưa quyết ở V1' + (br ? ' trong nhánh đang lọc' : '') + '.');
    if (!confirm(`Áp luật sàng V1 cho ${rows.length} bài chưa quyết? Bài đã quyết tay giữ nguyên. Mỗi bài ghi luật đã áp vào ghi chú "[tự động] …" để bạn rà lại.`)) return;
    const c = { INCLUDE: 0, EXCLUDE: 0, Unsure: 0 }, byCode = {};
    for (const r of rows) {
      const a = Core.autoV1(r, { yearFrom: num('#yearFrom', 0) || 2020 });
      const d = screen[r.key] = screen[r.key] || {};
      d.v1 = a.dec; d.v1r = a.code ? [a.code] : []; d.v1n = AUTO_TAG + a.rule;
      c[a.dec]++; if (a.code) byCode[a.code] = (byCode[a.code] || 0) + 1;
    }
    await save(); updateBadge(); $('#scStatus').value = 'auto'; renderScreen();
    log(`⚡ Sàng V1 tự động ${rows.length} bài: INCLUDE ${c.INCLUDE} · Unsure ${c.Unsure} · EXCLUDE ${c.EXCLUDE} (${Object.entries(byCode).map(([k, v]) => k + ' ' + v).join(', ')}). Rà lại ở bộ lọc "Tự động, chưa rà" — bấm quyết định là đánh dấu đã rà.`);
  });
  $('#btnAutoUndo').addEventListener('click', async () => {
    const ks = Object.keys(screen).filter(k => String(screen[k].v1n || '').startsWith(AUTO_TAG));
    if (!ks.length) return alertBox('Không có quyết định tự động nào chưa rà.');
    if (!confirm(`Bỏ ${ks.length} quyết định V1 tự động chưa rà (bài đã bấm rà giữ nguyên)?`)) return;
    for (const k of ks) { const d = screen[k]; delete d.v1; delete d.v1r; delete d.v1n; }
    await save(); updateBadge(); renderScreen(); log(`↺ Đã bỏ ${ks.length} quyết định tự động`);
  });
  $('#btnAutoRules').addEventListener('click', () => {
    const el = $('#autoRules'); el.classList.toggle('hidden');
    el.innerHTML = '<b>Luật sàng V1 tự động (theo thứ tự, gặp luật đầu tiên thì dừng):</b><ol>'
      + '<li>IC-Y năm &lt; năm tối thiểu · IC-L ngôn ngữ/tiêu đề không phải tiếng Anh · EC-S số trang &lt; 4 (khi biết số trang)</li>'
      + '<li>IC-T: loại tài liệu preprint/luận văn/dataset…, hoặc nơi đăng arXiv/SSRN/Zenodo/kho luận văn, hoặc abstract nói "this thesis/dissertation"</li>'
      + '<li>EC-N: tiêu đề là survey/review/mapping/editorial/special issue; abstract là đề cương PhD/giới thiệu số đặc biệt</li>'
      + '<li>IC-P: GraphQL/RPC không phải REST; không nhắc REST/web API; bài phát triển ứng dụng chỉ test chức năng</li>'
      + '<li>IC-I: hộp trắng/search-based cần mã nguồn; chỉ dùng LLM (không fuzzing/ngẫu nhiên/biên/phân hoạch/combinatorial); chỉ sinh oracle; công cụ đo coverage</li>'
      + '<li>Không có abstract → Unsure (đọc ở V2)</li>'
      + '<li>INCLUDE: REST + kỹ thuật sinh input hộp đen (fuzzing, random, black-box, property-based, combinatorial, constraint-based, EP, BVA, partition…)</li>'
      + '<li>Có sinh test nhưng chưa rõ kỹ thuật → Unsure; còn lại → EXCLUDE IC-I</li></ol>'
      + 'Luật chỉ là bộ lọc thô có ghi lại; người sàng rà lại từng nhóm và sửa nếu sai. V2 (đọc toàn văn) luôn làm tay.';
  });
  $('#scFind').addEventListener('input', renderScreen);
  function refreshCard(card) {
    const r = scRows.get(card.dataset.k); if (!r) return;
    const m = model();
    const tmp = document.createElement('div'); tmp.innerHTML = cardHtml(r, codeMap(m));
    card.replaceWith(tmp.firstChild);
    scProgress(m); updateBadge();
  }
  $('#scList').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const card = b.closest('.card'), k = card.dataset.k, st = stg();
    const d = screen[k] = screen[k] || {};
    if (b.dataset.act === 'dec') {
      d[st] = d[st] === b.dataset.v ? '' : b.dataset.v;     // bấm lại để bỏ chọn
      if (String(d[st + 'n'] || '').startsWith(AUTO_TAG)) d[st + 'n'] = REVIEWED_TAG + String(d[st + 'n']).slice(AUTO_TAG.length);
      if (d[st] === 'EXCLUDE' && !(d[st + 'r'] || []).length) log(`ℹ ${scRows.get(k).code}: EXCLUDE — nhớ chọn mã lý do (mã đầu tiên là mã chính)`);
    } else if (b.dataset.act === 'rc') {
      const arr = d[st + 'r'] = d[st + 'r'] || [];
      const i = arr.indexOf(b.dataset.v);
      if (i >= 0) arr.splice(i, 1); else arr.push(b.dataset.v);
      if (String(d[st + 'n'] || '').startsWith(AUTO_TAG)) d[st + 'n'] = REVIEWED_TAG + String(d[st + 'n']).slice(AUTO_TAG.length);
    }
    saveScreenSoon(); refreshCard(card);
  });
  $('#scList').addEventListener('change', e => {
    if (e.target.dataset.act !== 'note') return;
    const k = e.target.closest('.card').dataset.k, st = stg();
    (screen[k] = screen[k] || {})[st + 'n'] = e.target.value.trim();
    saveScreenSoon();
  });

  // ---------- PRISMA & XUẤT ----------
  const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`; };
  function flow() {
    const m = model();
    return { m, f: Prisma.flowMarkdown(runs, m, selected, screen, { owner: $('#pmOwner').value.trim(), sourceLabel: $('#pmSource').value.trim(), group: $('#pmGroup').value.trim(), date: today(), yearFrom: num('#snowYear', 0) || num('#yearFrom', 0) }) };
  }
  function renderPrisma() {
    const { f } = flow();
    $('#pmBox').textContent = f.md;
    $('#pmWarn').innerHTML = f.warnings.length ? `<div class="warnbox">⚠ ${f.warnings.length} việc chưa xong (vẫn xuất được nhưng số chưa chốt):<br>${f.warnings.map(esc).join('<br>')}</div>` : '';
  }
  ['#pmOwner', '#pmSource', '#pmGroup'].forEach(id => $(id).addEventListener('input', renderPrisma));
  const csvT = 'text/csv;charset=utf-8';
  $('#btnX01').addEventListener('click', () => { const { m } = flow(); download('01_all_records.csv', Prisma.csv01(m, selected), csvT); log('⬇ 01_all_records.csv'); });
  $('#btnX02').addEventListener('click', () => { const { m } = flow(); download('02_after_screening_v1.csv', Prisma.csv02(m, selected, screen), csvT); log('⬇ 02_after_screening_v1.csv'); });
  $('#btnX03').addEventListener('click', () => { const { m } = flow(); download('03_final_included.csv', Prisma.csv03(m, selected, screen), csvT); log('⬇ 03_final_included.csv'); });
  $('#btnXFlow').addEventListener('click', () => { const { f } = flow(); download('prisma-flow.md', f.md, 'text/markdown;charset=utf-8'); log('⬇ prisma-flow.md' + (f.warnings.length ? ` (⚠ còn ${f.warnings.length} việc chưa xong)` : '')); });
  $('#btnXLog').addEventListener('click', () => $('#btnLog').click());
  $('#btnBackup').addEventListener('click', () => {
    download(`rbl_backup_${stamp()}.json`, JSON.stringify({ app: 'RBL Paper Harvester', version: '1.5', exportedAt: new Date().toISOString(), runs, selected, screen, codes }, null, 1), 'application/json');
    log('⬇ Sao lưu toàn bộ (không chứa API key)');
  });
  $('#restoreFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!Array.isArray(j.runs)) throw new Error('file không đúng định dạng sao lưu');
      if (!confirm(`Khôi phục sẽ THAY toàn bộ dữ liệu hiện tại bằng file "${f.name}" (${j.runs.length} lượt chạy). Tiếp tục?`)) return;
      runs = j.runs; selected = j.selected || {}; screen = j.screen || {}; codes = j.codes || {};
      await save(); updateBadge(); renderPrisma(); log(`↺ Đã khôi phục từ ${f.name}`);
    } catch (err) { alertBox('Không khôi phục được: ' + err.message); }
    e.target.value = '';
  });

  function alertBox(m) { log('⚠ ' + m); alert(m); }

  loadKeys().then(load).then(() => log(hasChrome ? 'Sẵn sàng.' : 'Đang chạy ngoài extension — chỉ để xem giao diện (gọi API sẽ bị chặn CORS).'));
})();
