/* core.js — hàm thuần (không gọi mạng): dịch chuỗi tìm, chuẩn hoá, bỏ trùng, xuất CSV/log.
   Dùng được cả trong extension (window.Core) lẫn Node (module.exports) để kiểm thử. */
(function (root) {
  'use strict';

  // ---------- 1. Phân tích chuỗi tìm boolean ----------
  // Hỗ trợ: "cụm từ", từ đơn, AND, OR, NOT, ngoặc ( ). Hai term đứng cạnh nhau = AND.
  function normalizeQuotes(q) {
    return String(q || '').replace(/[“”„‟″«»]/g, '"').replace(/[‘’]/g, "'");
  }

  function tokenize(q) {
    const s = normalizeQuotes(q);
    const toks = [];
    const re = /"([^"]*)"|(\()|(\))|([^\s()"]+)/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[1] !== undefined) toks.push({ k: 'term', v: m[1].trim(), phrase: true });
      else if (m[2]) toks.push({ k: '(' });
      else if (m[3]) toks.push({ k: ')' });
      else {
        const w = m[4];
        if (w === 'AND' || w === 'OR' || w === 'NOT') toks.push({ k: w });
        else toks.push({ k: 'term', v: w, phrase: false });
      }
    }
    if ((s.match(/"/g) || []).length % 2) throw new Error('Chuỗi tìm có số dấu nháy kép lẻ — kiểm tra lại dấu "');
    return toks;
  }

  function parse(q) {
    const toks = tokenize(q);
    if (!toks.length) throw new Error('Chuỗi tìm đang trống');
    let i = 0;
    const peek = () => toks[i];
    function expr() { // OR có độ ưu tiên thấp nhất
      const c = [andExpr()];
      while (peek() && peek().k === 'OR') { i++; c.push(andExpr()); }
      return c.length === 1 ? c[0] : { t: 'or', c };
    }
    function andExpr() {
      const c = [unary()];
      while (peek() && (peek().k === 'AND' || peek().k === 'term' || peek().k === '(' || peek().k === 'NOT')) {
        if (peek().k === 'AND') i++;
        c.push(unary());
      }
      return c.length === 1 ? c[0] : { t: 'and', c };
    }
    function unary() {
      if (peek() && peek().k === 'NOT') { i++; return { t: 'not', c: unary() }; }
      return primary();
    }
    function primary() {
      const tk = toks[i++];
      if (!tk) throw new Error('Chuỗi tìm kết thúc bất ngờ (thiếu term sau AND/OR?)');
      if (tk.k === '(') {
        const e = expr();
        if (!toks[i] || toks[i].k !== ')') throw new Error('Thiếu dấu ngoặc đóng )');
        i++;
        return e;
      }
      if (tk.k === 'term') return { t: 'term', v: tk.v, phrase: tk.phrase };
      throw new Error('Không hiểu ký hiệu "' + tk.k + '" ở vị trí ' + i);
    }
    const ast = expr();
    if (i < toks.length) throw new Error('Thừa ký hiệu ở cuối chuỗi tìm (kiểm tra dấu ngoặc)');
    return ast;
  }

  function hasNot(n) { return n.t === 'not' || (n.c && [].concat(n.c).some(hasNot)); }

  // ---------- 2. Dịch sang cú pháp từng nguồn ----------
  function ser(n, o, top) {
    if (n.t === 'term') return o.term(n);
    if (n.t === 'not') return o.not(ser(n.c, o, false));
    const parts = n.c.map(x => ser(x, o, false));
    const s = parts.join(n.t === 'and' ? o.and : o.or);
    return top ? s : '(' + s + ')';
  }
  const quote = n => (n.phrase || /\s/.test(n.v)) ? '"' + n.v + '"' : n.v;

  const translate = {
    // OpenAlex, IEEE Xplore: nhận nguyên (P) AND (I) AND (O)
    boolean: ast => ser(ast, { term: quote, and: ' AND ', or: ' OR ', not: s => 'NOT ' + s }, true),
    // Semantic Scholar /paper/search/bulk: + = AND, | = OR, - = NOT
    s2: ast => ser(ast, { term: quote, and: ' + ', or: ' | ', not: s => '-' + s }, true),
    // arXiv: tiền tố all: cho từng term
    arxiv: ast => {
      if (hasNot(ast)) throw new Error('arXiv: chưa hỗ trợ NOT trong bản dịch tự động');
      return ser(ast, { term: n => 'all:' + quote(n), and: ' AND ', or: ' OR ', not: s => s }, true);
    },
    // Google Scholar (SerpAPI): AND ngầm định bằng dấu cách, OR viết hoa
    scholar: ast => ser(ast, { term: quote, and: ' ', or: ' OR ', not: s => '-' + s }, true),
  };

  // Tách thành các dòng từ khoá ngắn (dạng chuẩn tắc tuyển: OR của các AND) cho nguồn không hỗ trợ boolean
  function dnf(n) {
    if (n.t === 'term') return [[n.v]];
    if (n.t === 'not') return [[]];
    if (n.t === 'or') return n.c.flatMap(dnf);
    // and: tích Descartes
    return n.c.map(dnf).reduce((acc, cur) => acc.flatMap(a => cur.map(b => a.concat(b))), [[]]);
  }
  function keywordLines(ast, cap) {
    const lines = dnf(ast).map(t => t.join(' ')).filter(Boolean);
    const uniq = [...new Set(lines)];
    return { lines: uniq.slice(0, cap || 30), total: uniq.length, truncated: uniq.length > (cap || 30) };
  }

  // ---------- 3. Chuẩn hoá ----------
  function normDoi(d) {
    if (!d) return '';
    return String(d).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
  }
  function normTitle(t) {
    return String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }
  function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
  function invertedToText(inv) {
    if (!inv) return '';
    const pos = [];
    for (const [w, idx] of Object.entries(inv)) for (const i of idx) pos[i] = w;
    return pos.filter(x => x !== undefined).join(' ');
  }
  function makeRecord(o) {
    const doi = normDoi(o.doi);
    return {
      source: o.source || '',
      title: stripTags(o.title || ''),
      authors: (o.authors || []).filter(Boolean),
      year: o.year ? Number(o.year) || '' : '',
      venue: o.venue || '',
      doi,
      abstract: stripTags(o.abstract || ''),
      url: o.url || (doi ? 'https://doi.org/' + doi : ''),
      type: o.type || '',
      language: o.language || '',
      ids: o.ids || {},
      snowball: o.snowball || '',
      seed: o.seed ? normDoi(o.seed) : '',
      run: o.run || '',
      query: o.query || '',
      fetchedAt: o.fetchedAt || '',
      countsInPrisma: o.countsInPrisma !== false,
    };
  }

  // ---------- 4. Bỏ trùng ----------
  // Khoá: DOI; bản ghi không DOI so tiêu đề chuẩn hoá. Gộp giữ bản đầy đủ hơn.
  function dedup(records) {
    const out = [];
    const byDoi = new Map();
    const byTitle = new Map();
    const join = (a, b) => [...new Set(String(a || '').split(';').concat(String(b || '').split(';')).map(s => s.trim()).filter(Boolean))].join(';');
    for (const r0 of records) {
      const r = Object.assign({}, r0);
      const tk = normTitle(r.title);
      let hit = (r.doi && byDoi.get(r.doi)) || (tk && byTitle.get(tk));
      if (hit) {
        hit.source = join(hit.source, r.source);
        hit.run = join(hit.run, r.run);
        hit.snowball = join(hit.snowball, r.snowball);
        hit.seed = join(hit.seed, r.seed);
        if (!hit.doi && r.doi) { hit.doi = r.doi; byDoi.set(r.doi, hit); if (!hit.url) hit.url = 'https://doi.org/' + r.doi; }
        if ((r.abstract || '').length > (hit.abstract || '').length) hit.abstract = r.abstract;
        for (const f of ['venue', 'year', 'type', 'language', 'url']) if (!hit[f] && r[f]) hit[f] = r[f];
        if ((r.authors || []).length > (hit.authors || []).length) hit.authors = r.authors;
        hit.ids = Object.assign({}, r.ids, hit.ids);
        hit.countsInPrisma = hit.countsInPrisma || r.countsInPrisma;
        hit.dupCount = (hit.dupCount || 1) + 1;
        continue;
      }
      r.dupCount = 1;
      out.push(r);
      if (r.doi) byDoi.set(r.doi, r);
      if (tk) byTitle.set(tk, r);
    }
    return { records: out, before: records.length, after: out.length, removed: records.length - out.length };
  }

  // ---------- 5. Xuất CSV đúng format nhóm ----------
  const CSV_COLUMNS = ['ma', 'nguon', 'phien_ban', 'loai', 'doi', 'title', 'authors', 'year', 'venue', 'url', 'abstract',
    'ngon_ngu', 'snowball', 'seed', 'query', 'ngay_lay'];
  function loai(type) {
    const t = String(type || '').toLowerCase();
    if (/proceedings$|^proceedings|book|volume/.test(t) && !/article|paper/.test(t)) return 'tập kỷ yếu';
    if (/preprint|posted-content|arxiv/.test(t)) return 'preprint';
    if (/dissertation|thesis/.test(t)) return 'luận văn';
    if (/review/.test(t) && !/article/.test(t)) return t;
    if (!t) return '';
    return 'bài báo';
  }
  function csvCell(v) {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(records, opt) {
    const prefix = (opt && opt.prefix) || 'K';
    let n = (opt && Number(opt.start)) || 1;
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of records) {
      const ma = prefix + String(n++).padStart(2, '0');
      const row = {
        ma, nguon: r.source, phien_ban: r.run, loai: loai(r.type), doi: r.doi, title: r.title,
        authors: (r.authors || []).join('; '), year: r.year, venue: r.venue, url: r.url, abstract: r.abstract,
        ngon_ngu: r.language, snowball: r.snowball, seed: r.seed, query: r.query, ngay_lay: r.fetchedAt,
      };
      lines.push(CSV_COLUMNS.map(c => csvCell(row[c])).join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // ---------- 6. Log markdown cho search-log.md ----------
  const md = s => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  function searchLogMarkdown(runs, stats) {
    const out = [];
    const sr = runs.filter(r => r.kind === 'search');
    if (sr.length) {
      out.push('## Nhật ký chạy query (tạo bởi RBL Paper Harvester)', '');
      out.push('| Lần | Chuỗi gửi đi (nguyên văn) | CSDL | Trường tìm | Bộ lọc | Ngày chạy | Số kết quả nguồn báo | Số lấy về | Ghi chú |');
      out.push('|---|---|---|---|---|---|---|---|---|');
      for (const run of sr) for (const s of run.sources) {
        const sent = (s.sent || []).map(x => '`' + md(x) + '`').join('<br>');
        const note = [s.error ? '❌ LỖI: ' + s.error : '', ...(s.notes || [])].filter(Boolean).join('; ');
        out.push(`| ${md(run.label)} | ${sent} | ${md(s.name)} | ${md(s.field)} | ${md(s.filters)} | ${md(run.when)} | ${s.reported ?? 'N/A'} | ${s.fetched} | ${md(note)} |`);
      }
      out.push('');
    }
    const sb = runs.filter(r => r.kind === 'snowball');
    if (sb.length) {
      out.push('## Snowballing', '');
      out.push('| Seed (DOI) | Vòng | Hướng | Qua API | Số đã lướt | Số thêm vào 01 | Số include cuối | Ghi chú |');
      out.push('|---|---|---|---|---|---|---|---|');
      for (const run of sb) for (const s of run.sources) {
        const note = [s.error ? '❌ LỖI: ' + s.error : '', ...(s.notes || [])].filter(Boolean).join('; ');
        out.push(`| ${md(s.seed)} | ${md(run.round)} | ${md(s.direction)} | ${md(s.name)} | ${s.fetched} | ${s.added ?? '⬜'} | ⬜ | ${md(note)} |`);
      }
      out.push('');
    }
    if (stats) {
      out.push('## Tổng hợp', '');
      out.push(`- Tổng trước dedup: ${stats.before} · Sau dedup: ${stats.after} (bỏ ${stats.removed} bản trùng) · Đã chọn xuất vào 01: ${stats.selected}`);
      out.push('- Ghi chú: bản ghi từ Semantic Scholar / Google Scholar (SerpAPI) KHÔNG đếm vào PRISMA theo review-protocol.md §3.');
      out.push('');
    }
    return out.join('\n');
  }

  function redactUrl(u) {
    return String(u).replace(/([?&](api_key|apikey|key)=)[^&]*/gi, '$1***');
  }

  const Core = { normalizeQuotes, tokenize, parse, translate, keywordLines, dnf, normDoi, normTitle, stripTags,
    invertedToText, makeRecord, dedup, toCSV, CSV_COLUMNS, loai, searchLogMarkdown, redactUrl };
  root.Core = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof self !== 'undefined' ? self : globalThis);
