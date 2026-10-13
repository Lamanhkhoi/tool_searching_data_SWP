/* prisma.js — gộp bản ghi theo nhánh PRISMA, trạng thái screening V1/V2, mã K cố định, xuất 01/02/03 + prisma-flow.md.
   Hàm thuần (không đụng DOM) để test được bằng node. */
(function (root) {
  'use strict';
  const Core = root.Core || (typeof require !== 'undefined' ? require('./core.js') : null);

  // Thứ tự giai đoạn: bản ghi thuộc giai đoạn SỚM NHẤT mà nó xuất hiện
  const STAGES = ['db', 'other', 'sb1', 'sb2'];
  const STAGE_NAME = { db: 'Nhánh 1 — Tìm trong CSDL', other: 'Nguồn bổ sung (không đếm PRISMA theo protocol)', sb1: 'Nhánh 2 — Snowballing vòng 1', sb2: 'Nhánh 2 — Snowballing vòng 2' };
  const CODES = ['IC-L', 'IC-T', 'IC-E', 'IC-Y', 'IC-P', 'IC-I', 'EC-D', 'EC-A', 'EC-S', 'EC-N', 'EC-O'];
  const CODE_DESC = {
    'IC-L': 'không phải tiếng Anh', 'IC-T': 'không phải hội nghị/tạp chí', 'IC-E': 'không có kết quả định lượng',
    'IC-Y': 'trước 2020', 'IC-P': 'không về kiểm thử REST API mức request', 'IC-I': 'không dùng EP/BVA',
    'EC-D': 'trùng', 'EC-A': 'không có full text', 'EC-S': 'dưới 4 trang', 'EC-N': 'không có thực nghiệm',
    'EC-O': 'UI/E2E, unit test nội bộ hoặc chỉ báo lỗi',
  };

  const recKey = r => r.doi ? 'doi:' + r.doi : 't:' + Core.normTitle(r.title);
  const originOf = (run, r) => run.kind === 'snowball' ? 'sb' + (Number(run.round) === 2 ? 2 : 1) : (r.countsInPrisma === false ? 'other' : 'db');
  const codeNum = c => Number(String(c || '').replace(/\D+/g, '')) || 0;

  // Gộp + gắn giai đoạn. Không sửa dữ liệu lưu trữ (clone nông).
  function merge(runs) {
    const raw = [];
    for (const run of runs) for (const r of run.records || []) raw.push(Object.assign({}, r, { _origin: originOf(run, r) }));
    const d = Core.dedup(raw);
    const rawBy = {}; STAGES.forEach(s => { rawBy[s] = 0; });
    for (const r of raw) rawBy[r._origin]++;
    for (const m of d.records) {
      const os = m.origins && m.origins.length ? m.origins : ['db'];
      m.stage = STAGES.find(s => os.includes(s)) || 'db';
      m.key = recKey(m);
    }
    return { records: d.records, rawBy, before: d.before, after: d.after };
  }

  // Mã K cố định: cấp cho bài đã vào 01 (đã tick), theo thứ tự giai đoạn rồi thứ tự lấy về; không đổi về sau.
  function ensureCodes(records, selected, screen, codes, opt) {
    const prefix = (opt && opt.prefix) || 'K';
    const start = Math.max(1, Number(opt && opt.start) || 1);
    const used = Object.values(codes).map(codeNum);
    let next = Math.max(start - 1, ...used, 0) + 1;
    const ordered = STAGES.flatMap(s => records.filter(r => r.stage === s));
    let changed = false;
    for (const r of ordered) {
      const on = !!selected[r.key];
      const s = screen[r.key];
      if (on && !codes[r.key]) { codes[r.key] = prefix + String(next++).padStart(2, '0'); changed = true; }
      else if (!on && codes[r.key] && !(s && (s.v1 || s.v2))) { delete codes[r.key]; changed = true; }
    }
    for (const r of records) r.code = codes[r.key] || '';
    return changed;
  }

  const dec = (screen, r) => screen[r.key] || {};
  const v1Of = (screen, r) => dec(screen, r).v1 || '';
  const v2Of = (screen, r) => (['INCLUDE', 'Unsure'].includes(v1Of(screen, r)) ? dec(screen, r).v2 || '' : '');

  // Số liệu từng giai đoạn
  function stats(m, selected, screen) {
    const out = {};
    for (const s of STAGES) {
      const uniq = m.records.filter(r => r.stage === s);
      const in01 = uniq.filter(r => selected[r.key]);
      const v1 = k => in01.filter(r => v1Of(screen, r) === k);
      const ft = in01.filter(r => ['INCLUDE', 'Unsure'].includes(v1Of(screen, r)));
      const v2 = k => ft.filter(r => v2Of(screen, r) === k);
      out[s] = {
        raw: m.rawBy[s], uniq: uniq.length, dup: m.rawBy[s] - uniq.length,
        notAdded: uniq.length - in01.length, in01: in01.length,
        v1Exc: v1('EXCLUDE'), v1Inc: v1('INCLUDE'), v1Uns: v1('Unsure'), v1Pend: v1(''),
        ft: ft.length, v2Exc: v2('EXCLUDE'), v2Inc: v2('INCLUDE'), v2Pend: v2(''),
        back: uniq.filter(r => /snowball-back/.test(r.snowball)).length,
        fwd: uniq.filter(r => /snowball-fwd/.test(r.snowball)).length,
        rawBack: 0, rawFwd: 0,
      };
    }
    return out;
  }

  // Seed cho vòng snowballing: vòng 1 = INCLUDE (V2) của nhánh CSDL (+ nguồn bổ sung); vòng 2 = INCLUDE của vòng 1
  function seedsFor(round, m, selected, screen) {
    const from = round === 2 ? ['sb1'] : ['db', 'other'];
    const inc = m.records.filter(r => from.includes(r.stage) && selected[r.key] && v2Of(screen, r) === 'INCLUDE');
    const pend = m.records.filter(r => from.includes(r.stage) && selected[r.key] && (!v1Of(screen, r) || (['INCLUDE', 'Unsure'].includes(v1Of(screen, r)) && !v2Of(screen, r)))).length;
    return { seeds: inc.map(r => ({ id: r.doi || (r.ids && r.ids.openalex) || '', code: r.code, title: r.title })), pending: pend };
  }

  // ---------- CSV đúng format repo ----------
  const csv = rows => '﻿' + rows.map(r => r.map(Core.csvCell).join(',')).join('\r\n') + '\r\n';
  const nguon = r => r.stage && r.stage.startsWith('sb')
    ? String(r.snowball || '').split(';').filter(x => /^snowball-/.test(x)).join(';') || 'snowball'
    : r.source;
  const baseCols = ['ma', 'nguon', 'phien_ban', 'loai', 'doi', 'title', 'authors', 'year', 'venue', 'url', 'abstract'];
  const baseVals = r => [r.code, nguon(r), r.run, Core.loai(r.type), r.doi, r.title, (r.authors || []).join('; '), r.year, r.venue, r.url || (r.doi ? 'https://doi.org/' + r.doi : ''), r.abstract];
  const byCode = (a, b) => codeNum(a.code) - codeNum(b.code);
  const reasons = arr => (arr || []).join('; ');

  function csv01(m, selected) {
    const rows = m.records.filter(r => selected[r.key] && r.code).sort(byCode);
    return csv([baseCols.concat(['ngon_ngu', 'snowball', 'seed', 'query', 'ngay_lay']),
      ...rows.map(r => baseVals(r).concat([r.language, r.snowball, r.seed, r.query, r.fetchedAt]))]);
  }
  function csv02(m, selected, screen) {
    const rows = m.records.filter(r => selected[r.key] && r.code).sort(byCode);
    return csv([baseCols.concat(['v1_decision', 'v1_reason', 'v1_note']),
      ...rows.map(r => { const s = dec(screen, r); return baseVals(r).concat([s.v1 || '', reasons(s.v1r), s.v1n || '']); })]);
  }
  function csv03(m, selected, screen) {
    const rows = m.records.filter(r => selected[r.key] && r.code && ['INCLUDE', 'Unsure'].includes(v1Of(screen, r))).sort(byCode);
    return csv([baseCols.concat(['v1_decision', 'v1_reason', 'v1_note', 'v2_decision', 'v2_reason']),
      ...rows.map(r => { const s = dec(screen, r); const why = reasons(s.v2r) + (s.v2n ? (s.v2r && s.v2r.length ? ' — ' : '') + s.v2n : '');
        return baseVals(r).concat([s.v1 || '', reasons(s.v1r), s.v1n || '', s.v2 || '', why]); })]);
  }

  // ---------- prisma-flow.md ----------
  function listCodes(rs) {
    const c = rs.map(r => r.code).filter(Boolean).sort((a, b) => codeNum(a) - codeNum(b));
    if (c.length > 12) return c.slice(0, 12).join(', ') + ` … (+${c.length - 12})`;
    return c.join(', ');
  }
  function reasonTables(rs, field, screen) {
    if (!rs.length) return [];
    const main = {}, sec = {};
    for (const r of rs) {
      const codes = (dec(screen, r)[field] || []);
      const k = codes[0] || '(chưa ghi mã)';
      (main[k] = main[k] || []).push(r);
      for (const c of codes.slice(1)) (sec[c] = sec[c] || []).push(r);
    }
    const lbl = k => CODE_DESC[k] ? `${k} (${CODE_DESC[k]})` : k;
    const out = ['| Mã chính | Số bài | Bài |', '|---|---|---|'];
    for (const [k, v] of Object.entries(main).sort((a, b) => b[1].length - a[1].length)) out.push(`| ${lbl(k)} | ${v.length} | ${listCodes(v)} |`);
    if (Object.keys(sec).length) {
      out.push('', `Lý do phụ (một bài có thể trượt nhiều tiêu chí, ghi đủ trong cột \`${field === 'v1r' ? 'v1_reason' : 'v2_reason'}\`):`, '', '| Mã | Số bài | Bài |', '|---|---|---|');
      for (const [k, v] of Object.entries(sec).sort((a, b) => b[1].length - a[1].length)) out.push(`| ${lbl(k)} | ${v.length} | ${listCodes(v)} |`);
    }
    return out;
  }
  const brief = (rs, screen, field) => {
    const c = {}; for (const r of rs) { const k = (dec(screen, r)[field] || [])[0] || '?'; c[k] = (c[k] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} = ${n}`).join(', ');
  };
  const pad = (s, n) => s + ' '.repeat(Math.max(1, n - [...s].length));

  function flowMarkdown(runs, m, selected, screen, meta) {
    const st = stats(m, selected, screen);
    const recs = s => m.records.filter(r => r.stage === s);
    const W = 44;
    const out = [`# PRISMA flow — ${meta.owner || ''}${meta.sourceLabel ? ' · nguồn phụ trách: ' + meta.sourceLabel : ''}`,
      `*${meta.group || ''}${meta.group ? ' · ' : ''}Cập nhật: ${meta.date} · tạo bởi RBL Paper Harvester*`, ''];
    const checks = [];
    const warn = [];
    for (const s of STAGES) {
      const x = st[s];
      if (!x.raw && s !== 'db') continue;
      const runsOf = runs.filter(run => (s.startsWith('sb') ? run.kind === 'snowball' && ('sb' + (Number(run.round) === 2 ? 2 : 1)) === s
        : run.kind === 'search' && (run.records || []).some(r => (r.countsInPrisma === false ? 'other' : 'db') === s)));
      const labels = runsOf.map(r => `${r.label} ${(r.records || []).filter(rr => s.startsWith('sb') || (rr.countsInPrisma === false ? 'other' : 'db') === s).length}`).join(' + ');
      const srcNames = [...new Set(recs(s).flatMap(r => String(r.source || '').split(';')))].filter(Boolean).join(', ');
      out.push(`## ${STAGE_NAME[s]}`, '');
      if (s.startsWith('sb')) {
        const seeds = [...new Set(runsOf.flatMap(run => run.sources.map(x2 => x2.seed)))].filter(Boolean);
        out.push(`Seed: ${seeds.length} bài (${s === 'sb1' ? 'INCLUDE của nhánh 1' : 'INCLUDE của vòng 1'}) · lấy bài từ năm ${meta.yearFrom || '—'} ở cả hai hướng`, '');
      }
      out.push('```');
      const first = s.startsWith('sb')
        ? `[Tìm được qua snowballing (N = ${x.raw})]`
        : `[Paper từ ${srcNames || 'nguồn'} (N = ${x.raw})]`;
      out.push(pad(first, W) + `← ${s.startsWith('sb') ? 'lùi + tiến, ' : 'search-log: '}${labels || '—'}`);
      out.push(pad('        ↓', W));
      out.push(pad(`[Sau dedup (N = ${x.uniq})]`, W) + `← bỏ ${x.dup} bản trùng${s.startsWith('sb') ? ' (trùng nhau hoặc đã có ở bước trước)' : ''}`);
      out.push('        ↓');
      if (x.notAdded) {
        out.push(pad(`[Lướt tiêu đề, không thêm vào 01 (N = ${x.notAdded})]`, W) + '← bỏ tick ở tab 3');
        out.push('        ↓');
      }
      out.push(pad(`[Vào 01 → screening V1 (N = ${x.in01})]`, W) + '← = số dòng của nhánh này trong 01_all_records.csv');
      out.push('        ↓');
      out.push(pad(`[Loại V1 (N = ${x.v1Exc.length})${x.v1Exc.length ? ': ' + brief(x.v1Exc, screen, 'v1r') : ''}]`, W) + '← EXCLUDE trong 02_after_screening_v1.csv (mã chính)');
      out.push('        ↓');
      out.push(pad(`[Full-text đọc (N = ${x.ft})]`, W) + `← INCLUDE ${x.v1Inc.length} + Unsure ${x.v1Uns.length} ở 02 = số dòng trong 03`);
      out.push('        ↓');
      out.push(pad(`[Loại V2 (N = ${x.v2Exc.length})${x.v2Exc.length ? ': ' + brief(x.v2Exc, screen, 'v2r') : ''}]`, W));
      out.push('        ↓');
      out.push(pad(`[Included (N = ${x.v2Inc.length})]`, W) + '← INCLUDE trong cột v2_decision của 03_final_included.csv');
      out.push('```', '');
      const ok1 = x.raw - x.dup === x.uniq, ok2 = x.uniq - x.notAdded === x.in01;
      const ok3 = x.in01 - x.v1Exc.length - x.v1Pend.length === x.ft, ok4 = x.ft - x.v2Exc.length - x.v2Pend.length === x.v2Inc.length;
      const allOk = ok1 && ok2 && ok3 && ok4;
      out.push(`**Kiểm cộng trừ:** ${x.raw} − ${x.dup} = ${x.uniq} · ${x.uniq} − ${x.notAdded} = ${x.in01} · ${x.in01} − ${x.v1Exc.length}${x.v1Pend.length ? ' − ' + x.v1Pend.length + ' chưa quyết' : ''} = ${x.ft} · ${x.ft} − ${x.v2Exc.length}${x.v2Pend.length ? ' − ' + x.v2Pend.length + ' chưa quyết' : ''} = ${x.v2Inc.length} ${allOk ? '✓' : '✗'}`, '');
      checks.push(allOk);
      if (x.v1Pend.length) warn.push(`${STAGE_NAME[s]}: ${x.v1Pend.length} bài chưa quyết ở V1 (${listCodes(x.v1Pend)})`);
      if (x.v2Pend.length) warn.push(`${STAGE_NAME[s]}: ${x.v2Pend.length} bài chưa quyết ở V2 (${listCodes(x.v2Pend)})`);
      const noR1 = x.v1Exc.filter(r => !(dec(screen, r).v1r || []).length), noR2 = x.v2Exc.filter(r => !(dec(screen, r).v2r || []).length);
      if (noR1.length) warn.push(`${STAGE_NAME[s]}: ${noR1.length} bài EXCLUDE ở V1 chưa ghi mã lý do (${listCodes(noR1)})`);
      if (noR2.length) warn.push(`${STAGE_NAME[s]}: ${noR2.length} bài EXCLUDE ở V2 chưa ghi mã lý do (${listCodes(noR2)})`);
      if (x.v1Exc.length) out.push('### Lý do loại ở V1', '', ...reasonTables(x.v1Exc, 'v1r', screen), '');
      if (x.v2Exc.length) out.push('### Lý do loại ở V2', '', ...reasonTables(x.v2Exc, 'v2r', screen), '');
    }
    const incDb = st.db.v2Inc.length, inc1 = st.sb1.v2Inc.length, inc2 = st.sb2.v2Inc.length, incO = st.other.v2Inc.length;
    out.push('## Tổng', '');
    out.push(`- Included cuối = nhánh 1 (${incDb}) + snowballing vòng 1 (${inc1}) + snowballing vòng 2 (${inc2}) = **${incDb + inc1 + inc2}**`
      + (st.other.raw ? ` · nguồn bổ sung không đếm PRISMA: ${incO} (ghi riêng)` : ''));
    out.push(`- Tất cả phép kiểm cộng trừ: ${checks.every(Boolean) ? '✓ khớp' : '✗ có ô không khớp, kiểm tra lại'}`);
    if (incDb === 0 && st.db.v1Pend.length === 0 && st.db.v2Pend.length === 0 && st.db.raw) out.push('- Nhánh 1 không có bài INCLUDE → không có seed cho snowballing vòng 1.');
    if (warn.length) out.push('', '## ⚠ Chưa hoàn tất', '', ...warn.map(w => '- ' + w));
    out.push('');
    return { md: out.join('\n'), stats: st, warnings: warn, ok: checks.every(Boolean) };
  }

  // Ghi "Số thêm vào 01" và "Số include cuối" cho bảng snowballing trong search-log
  function annotateRuns(runs, m, selected, screen) {
    return runs.map(run => run.kind !== 'snowball' ? run : Object.assign({}, run, {
      sources: run.sources.map(s => {
        const tag = s.direction === 'lùi' ? 'snowball-back' : 'snowball-fwd';
        const mine = m.records.filter(r => r.stage && r.stage.startsWith('sb') && (r.seed || '').split(';').includes(s.seed) && (r.snowball || '').split(';').includes(tag));
        const added = mine.filter(r => selected[r.key]);
        return Object.assign({}, s, { added: added.length, included: added.filter(r => v2Of(screen, r) === 'INCLUDE').length });
      }),
    }));
  }

  const Prisma = { STAGES, STAGE_NAME, CODES, CODE_DESC, recKey, merge, ensureCodes, stats, seedsFor, csv01, csv02, csv03, flowMarkdown, annotateRuns, v1Of, v2Of };
  root.Prisma = Prisma;
  if (typeof module !== 'undefined' && module.exports) module.exports = Prisma;
})(typeof self !== 'undefined' ? self : globalThis);
