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
      numpages: Number(o.numpages) || '',
      snippet: !!o.snippet,           // true = 'abstract' chỉ là đoạn trích ngắn (Google Scholar)
      enriched: o.enriched || '',
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
        {
          const ra = r.abstract || '', ha = hit.abstract || '';
          const better = ra && (!ha || (hit.snippet && !r.snippet) || (ra.length > ha.length && !(r.snippet && !hit.snippet)));
          if (better) { hit.abstract = ra; hit.snippet = !!r.snippet; }
        }
        if (!hit.enriched && r.enriched) hit.enriched = r.enriched;
        for (const f of ['venue', 'year', 'type', 'language', 'url', 'numpages']) if (!hit[f] && r[f]) hit[f] = r[f];
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

  // ---------- 4b. Sơ loại (GỢI Ý) theo IC/EC của nhóm — đọc TOÀN BỘ tiêu đề + abstract ----------
  // Chỉ gợi ý để bạn đọc trước. Quyết định INCLUDE/EXCLUDE/Unsure vẫn là của người đọc (RBL-1 bước A2).
  const RX = {
    P: [/\brestful\b/, /\brest[\s-]?(?:api|apis|service|services|endpoint|endpoints|based)\b/, /\bweb apis?\b/, /\bhttp apis?\b/,
      /\bopenapi\b/, /\bswagger\b/, /\bweb services?\b/],
    I: [/\bequivalence[\s-]+(?:partition\w*|class\w*)/, /\bboundary[\s-]+(?:value|values|testing|analysis|condition|conditions)\b/,
      /\bbva\b/, /\binput[\s-]+(?:space[\s-]+)?partition\w*/, /\bpartition[\s-]+testing\b/],
    O: [/\bselenium\b/, /\bend[\s-]to[\s-]end\b/, /\be2e\b/, /\bgui\b/, /\bweb ui\b/, /\buser interface\b/, /\bandroid\b/, /\bmobile app\w*/],
  };
  const RX_TEST = /\btest(?:s|ing|ed|er|ers)?\b/;
  const RX_NUM_WORD = /(coverage|fault|mutant|mutation|bug|defect|detect|precision|recall|accuracy|score|%|percent)/;
  const EN_STOP = new Set(['the', 'of', 'and', 'for', 'in', 'to', 'with', 'is', 'are', 'we', 'that', 'this', 'by', 'on', 'an', 'as', 'from', 'which', 'our']);
  function looksEnglish(text) {
    const w = String(text || '').toLowerCase().match(/[a-z']+/g) || [];
    if (w.length < 8) return null;               // quá ngắn để kết luận
    let c = 0; for (const x of w) if (EN_STOP.has(x)) c++;
    return c / w.length >= 0.12;
  }
  // Tiêu đề không phải tiếng Anh: ≥2 từ đặc trưng (Indonesia/Malay, Tây Ban Nha/Bồ Đào Nha, Đức, Việt…) hoặc chữ không phải Latin
  const NON_EN_TITLE = /\b(pengujian|metode|pada|dan|dengan|untuk|sistem|aplikasi|berbasis|menggunakan|implementasi|analisis|yang|perancangan|pembangunan|pengembangan|penerapan|sebagai|rancang|bangun|informasi|studi|kasus|terhadap|otomatis|pembuatan|teknik|evaluasi|kualitas|perangkat|lunak|uji|para|uma|com|em|del|las|los|una|desarrollo|pruebas|und|der|die|für|von|zur|kiểm|thử|phần|mềm|của|và)\b/gi;
  function titleNonEnglish(t) {
    const s = String(t || '');
    const letters = s.match(/\p{L}/gu) || [];
    if (letters.length >= 10 && (s.match(/[^\u0000-ɏ\s\d\p{P}\p{S}]/gu) || []).length / letters.length > 0.3) return true;
    if ((s.match(/[\u00C0-\u024F]/g) || []).length >= 3) return true;   // nhiều chữ có dấu (Séc, Ba Lan, Việt…)
    return new Set((s.toLowerCase().match(NON_EN_TITLE) || [])).size >= 2;
  }
  function matchAll(list, text) {
    const out = [];
    for (const rx of list) { const m = text.match(rx); if (m) out.push(m[0].trim()); }
    return [...new Set(out)];
  }
  function screen(r, opt) {
    const yearFrom = opt && opt.yearFrom !== undefined ? Number(opt.yearFrom) : 2020;
    const title = r.title || '', abs = r.abstract || '';
    const text = (title + ' . ' + abs).toLowerCase();
    const found = { P: matchAll(RX.P, text), I: matchAll(RX.I, text), O: matchAll(RX.O, text) };
    const hasAbs = abs.length >= 80 && !r.snippet;
    const reasons = [], notes = [];
    const y = Number(r.year);
    if (yearFrom && y && y < yearFrom) reasons.push('IC-Y: năm ' + y);
    if (r.numpages && Number(r.numpages) < 4) reasons.push('EC-S: ' + r.numpages + ' trang');
    const lg = String(r.language || '').toLowerCase();
    if (lg && !lg.startsWith('en')) reasons.push('IC-L: ngôn ngữ ' + lg);
    else if (titleNonEnglish(title)) reasons.push('IC-L: tiêu đề có vẻ không phải tiếng Anh');
    else if (!lg && !r.snippet && abs.length > 40 && looksEnglish(abs) === false) reasons.push('IC-L: abstract có vẻ không phải tiếng Anh');
    let flag;
    if (reasons.length) flag = 'LOẠI?';
    else if (found.P.length && found.I.length) flag = 'ƯU TIÊN';
    else if (found.P.length || found.I.length) flag = 'XEM';
    else if (!hasAbs) flag = 'THIẾU ABSTRACT';
    else flag = 'ÍT KHẢ NĂNG';
    if (found.O.length) notes.push('EC-O?: ' + found.O.join(', '));
    if (!RX_TEST.test(text)) notes.push('không thấy từ "test"');
    if (hasAbs) notes.push(/\d/.test(abs) && RX_NUM_WORD.test(abs.toLowerCase()) ? 'IC-E: abstract có số liệu' : 'IC-E: abstract chưa thấy số liệu');
    else notes.push(r.snippet ? 'chỉ có đoạn trích (snippet), chưa có abstract' : 'chưa có abstract');
    return { flag, found, reasons, notes, hasAbs };
  }
  const FLAGS = ['ƯU TIÊN', 'XEM', 'THIẾU ABSTRACT', 'ÍT KHẢ NĂNG', 'LOẠI?'];
  function matchedTerms(sc) {
    return ['P', 'I'].map(k => sc.found[k].length ? k + ': ' + sc.found[k].join('/') : '').filter(Boolean).join(' · ');
  }

  // ---------- 4c. DOI nằm sẵn trong đường link (không cần gửi request) ----------
  // vd dl.acm.org/doi/abs/10.1145/..., link.springer.com/chapter/10.1007/..., onlinelibrary.wiley.com/doi/pdf/10.1002/...
  //    arxiv.org/abs/2510.27417v2 → 10.48550/arXiv.2510.27417
  function doiFromUrl(url) {
    let u = String(url || '');
    try { u = decodeURIComponent(u); } catch (_) { /* giữ nguyên */ }
    const ax = u.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i);
    if (ax) return '10.48550/arxiv.' + ax[1];
    const m = u.match(/\b(10\.\d{4,9}\/[^\s?#&"'<>]+)/);
    if (!m) return '';
    let d = m[1].replace(/\/(full|abstract|abs|pdf|epdf|html|fulltext\.html|summary|meta)$/i, '').replace(/\.pdf$/i, '').replace(/[.,;)\]]+$/, '');
    return normDoi(d);
  }

  // ---------- 4d. Đọc file BibTeX export từ ACM DL (Export Citations → BibTeX) ----------
  function parseBibTeX(text) {
    const out = [];
    const s = String(text || '');
    let i = 0;
    while ((i = s.indexOf('@', i)) !== -1) {
      const head = s.slice(i).match(/^@(\w+)\s*([{(])/);
      if (!head) { i++; continue; }
      const type = head[1].toLowerCase();
      const open = head[2], close = open === '{' ? '}' : ')';
      let j = i + head[0].length, depth = 1, inQ = false;
      const start = j;
      for (; j < s.length && depth > 0; j++) {
        const c = s[j];
        if (c === '\\') { j++; continue; }
        if (c === '"' && depth === 1) inQ = !inQ;
        else if (!inQ && (c === '{' || c === open)) depth++;
        else if (!inQ && (c === '}' || c === close)) depth--;
      }
      const body = s.slice(start, j - 1);
      i = j;
      if (type === 'comment' || type === 'preamble' || type === 'string') continue;
      const comma = body.indexOf(',');
      const key = body.slice(0, comma).trim();
      const fields = {};
      let k = comma + 1;
      while (k < body.length) {
        const fm = body.slice(k).match(/^\s*([\w-]+)\s*=\s*/);
        if (!fm) break;
        const name = fm[1].toLowerCase();
        k += fm[0].length;
        let val = '';
        if (body[k] === '{') {
          let d = 0, q = k;
          for (; q < body.length; q++) { if (body[q] === '\\') { q++; continue; } if (body[q] === '{') d++; else if (body[q] === '}') { d--; if (d === 0) break; } }
          val = body.slice(k + 1, q); k = q + 1;
        } else if (body[k] === '"') {
          let q = k + 1; for (; q < body.length && body[q] !== '"'; q++) if (body[q] === '\\') q++;
          val = body.slice(k + 1, q); k = q + 1;
        } else { const q = body.slice(k).match(/^[^,]*/)[0]; val = q.trim(); k += q.length; }
        fields[name] = val;
        const nx = body.slice(k).match(/^\s*,?/); k += nx ? nx[0].length : 0;
      }
      out.push({ type, key, fields });
    }
    return out;
  }
  const bibClean = v => String(v || '').replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\["'`^~=.]\{?(\w)\}?/g, '$1').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  function bibToRecords(entries, base) {
    return entries.map(e => {
      const f = e.fields;
      const pages = f.numpages || (/^(\d+)\s*-+\s*(\d+)$/.test(f.pages || '') ? (() => { const [a, b] = f.pages.split(/-+/).map(Number); return b >= a ? b - a + 1 : ''; })() : '');
      return makeRecord(Object.assign({
        source: 'ACM DL', title: bibClean(f.title),
        authors: bibClean(f.author).split(/\s+and\s+/).map(x => x.trim()).filter(Boolean),
        year: f.year, venue: bibClean(f.booktitle || f.journal || f.series || ''), doi: f.doi || doiFromUrl(f.url),
        abstract: bibClean(f.abstract), url: f.url || (f.doi ? 'https://doi.org/' + f.doi : ''),
        type: e.type === 'inproceedings' ? 'proceedings-article' : e.type === 'article' ? 'journal-article' : e.type,
        language: '', numpages: pages, ids: { bibkey: e.key },
      }, base));
    });
  }

  // ---------- 5. Xuất CSV đúng format nhóm ----------
  const CSV_COLUMNS = ['ma', 'nguon', 'phien_ban', 'loai', 'doi', 'title', 'authors', 'year', 'venue', 'url', 'abstract',
    'ngon_ngu', 'snowball', 'seed', 'query', 'ngay_lay', 'goi_y_so_loai', 'tu_khoa_khop'];
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
      const sc = screen(r, { yearFrom: opt && opt.yearFrom });
      const row = {
        ma, nguon: r.source, phien_ban: r.run, loai: loai(r.type), doi: r.doi, title: r.title,
        authors: (r.authors || []).join('; '), year: r.year, venue: r.venue, url: r.url, abstract: r.abstract,
        ngon_ngu: r.language, snowball: r.snowball, seed: r.seed, query: r.query, ngay_lay: r.fetchedAt,
        goi_y_so_loai: sc.flag + (sc.reasons.length ? ' (' + sc.reasons.join('; ') + ')' : ''), tu_khoa_khop: matchedTerms(sc),
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
    invertedToText, makeRecord, dedup, screen, doiFromUrl, parseBibTeX, bibToRecords, matchedTerms, FLAGS, RX, toCSV, CSV_COLUMNS, loai, searchLogMarkdown, redactUrl };
  root.Core = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof self !== 'undefined' ? self : globalThis);
