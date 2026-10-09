/* sources.js — adapter cho từng nguồn + snowballing.
   Mỗi adapter: gửi request có phân trang, timeout, thử lại khi HTTP 429 (có giới hạn),
   lỗi khác thì DỪNG nguồn đó và báo lỗi (không bỏ qua im lặng — thiếu record là số PRISMA sai). */
(function (root) {
  'use strict';
  const Core = root.Core || (typeof require !== 'undefined' ? require('./core.js') : null);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- HTTP có timeout + retry 429 ----------
  const lastRequests = []; // để debug: mở lại request gần nhất trong tab mới
  function makeHttp(fetchImpl, log, stopFlag) {
    const f = fetchImpl || ((...a) => fetch(...a));
    async function get(url, { headers = {}, label = '', as = 'json', timeout = 20000, maxRetry = 5 } = {}) {
      for (let attempt = 0; ; attempt++) {
        if (stopFlag && stopFlag.stop) throw new Error('Người dùng đã bấm Dừng');
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
        let res;
        lastRequests.unshift({ url, label, at: new Date().toLocaleTimeString() });
        lastRequests.length = Math.min(lastRequests.length, 20);
        log(`${label}: GET ${Core.redactUrl(url)}`);
        try {
          res = await f(url, { headers, signal: ctrl ? ctrl.signal : undefined });
        } catch (e) {
          if (timer) clearTimeout(timer);
          if (attempt < 2) { log(`${label}: lỗi mạng/timeout, thử lại lần ${attempt + 1}…`); await sleep(3000); continue; }
          throw new Error(`lỗi mạng hoặc quá ${timeout / 1000}s không phản hồi (${e.message})`);
        }
        if (timer) clearTimeout(timer);
        if (res.status === 429) {
          if (attempt >= maxRetry) throw new Error(`HTTP 429 (quá tốc độ) quá ${maxRetry} lần — đã dừng`);
          const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0;
          const wait = ra ? ra * 1000 : 5000 * (attempt + 1);
          log(`${label}: HTTP 429 quá tốc độ — chờ ${Math.round(wait / 1000)}s rồi thử lại (${attempt + 1}/${maxRetry})`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) {
          let body = '';
          try { body = (await res.text()).slice(0, 200); } catch (_) { /* bỏ qua */ }
          throw new Error(`HTTP ${res.status} ${body}`.trim());
        }
        return as === 'text' ? res.text() : res.json();
      }
    }
    return { get };
  }

  const nowStamp = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function result(name, extra) {
    return Object.assign({ name, field: '', filters: '', sent: [], reported: null, fetched: 0, records: [], notes: [], error: '' }, extra);
  }

  // ---------- Mapping từng nguồn → record chuẩn ----------
  const OA_SELECT = 'id,doi,display_name,authorships,publication_year,primary_location,abstract_inverted_index,type,language,referenced_works';
  function mapOpenAlex(w, base) {
    return Core.makeRecord(Object.assign({
      source: 'OpenAlex', title: w.display_name || w.title,
      authors: (w.authorships || []).map(a => a.author && a.author.display_name),
      year: w.publication_year, venue: (((w.primary_location || {}).source) || {}).display_name || '',
      doi: w.doi, abstract: Core.invertedToText(w.abstract_inverted_index),
      url: w.doi || w.id, type: w.type, language: w.language,
      ids: { openalex: String(w.id || '').split('/').pop() },
    }, base));
  }
  const S2_FIELDS = 'title,abstract,year,venue,externalIds,authors,url,publicationTypes,publicationVenue';
  function mapS2(p, base) {
    const ext = p.externalIds || {};
    return Core.makeRecord(Object.assign({
      source: 'Semantic Scholar', title: p.title, authors: (p.authors || []).map(a => a.name),
      year: p.year, venue: p.venue || ((p.publicationVenue || {}).name) || '', doi: ext.DOI,
      abstract: p.abstract, url: ext.DOI ? 'https://doi.org/' + ext.DOI : p.url,
      type: (p.publicationTypes || []).join(';'), ids: { s2: p.paperId, arxiv: ext.ArXiv },
      countsInPrisma: false,
    }, base));
  }

  // ---------- Adapter tìm kiếm ----------
  const adapters = {};

  adapters.openalex = async function (ctx) {
    const { ast, opt, keys, http, log } = ctx;
    const q = Core.translate.boolean(ast);
    const r = result('OpenAlex');
    const filters = [];
    if (opt.yearFrom) filters.push(`publication_year:>${Number(opt.yearFrom) - 1}`);
    if (opt.oaField === 'title_abstract') {
      if (q.includes(',')) throw new Error('OpenAlex: chuỗi tìm có dấu phẩy, không dùng được trong filter title_and_abstract.search');
      filters.unshift(`title_and_abstract.search:${q}`);
      r.field = 'title-abstract';
    } else r.field = 'mặc định (title + abstract + fulltext)';
    r.filters = opt.yearFrom ? `year ≥ ${opt.yearFrom}` : 'không';
    let cursor = '*';
    r.sent.push(q);
    while (cursor && r.records.length < opt.max) {
      const p = new URLSearchParams();
      if (opt.oaField !== 'title_abstract') p.set('search', q);
      if (filters.length) p.set('filter', filters.join(','));
      p.set('per-page', '200'); p.set('cursor', cursor); p.set('select', OA_SELECT);
      if (keys.openalex) p.set('api_key', keys.openalex);
      if (keys.mailto) p.set('mailto', keys.mailto);
      const data = await http.get('https://api.openalex.org/works?' + p.toString(), { label: 'OpenAlex' });
      if (r.reported === null) r.reported = (data.meta || {}).count ?? null;
      for (const w of data.results || []) r.records.push(mapOpenAlex(w, ctx.base));
      cursor = (data.meta || {}).next_cursor;
      log(`OpenAlex: ${r.records.length}/${r.reported}`);
    }
    if (r.reported > r.records.length) r.notes.push(`chỉ lấy ${r.records.length}/${r.reported} (giới hạn ${opt.max})`);
    return r;
  };

  adapters.s2 = async function (ctx) {
    const { ast, opt, keys, http, log } = ctx;
    const q = Core.translate.s2(ast);
    const r = result('Semantic Scholar', { field: 'title + abstract (bulk search)', filters: opt.yearFrom ? `year ≥ ${opt.yearFrom}` : 'không' });
    r.sent.push(q);
    r.notes.push('không đếm vào PRISMA (review-protocol §3)');
    const headers = keys.s2 ? { 'x-api-key': keys.s2 } : {};
    let token = null;
    do {
      const p = new URLSearchParams({ query: q, fields: S2_FIELDS });
      if (opt.yearFrom) p.set('year', `${opt.yearFrom}-`);
      if (token) p.set('token', token);
      const data = await http.get('https://api.semanticscholar.org/graph/v1/paper/search/bulk?' + p.toString(), { headers, label: 'Semantic Scholar' });
      if (r.reported === null) r.reported = data.total ?? null;
      for (const pp of data.data || []) { if (r.records.length < opt.max) r.records.push(mapS2(pp, ctx.base)); }
      token = data.token;
      log(`Semantic Scholar: ${r.records.length}/${r.reported}`);
      await sleep(keys.s2 ? 1100 : 3000);
    } while (token && r.records.length < opt.max);
    if (r.reported > r.records.length) r.notes.push(`chỉ lấy ${r.records.length}/${r.reported} (giới hạn ${opt.max})`);
    return r;
  };

  adapters.ieee = async function (ctx) {
    const { ast, opt, keys, http, log } = ctx;
    const r = result('IEEE Xplore', { field: 'querytext (metadata)', filters: opt.yearFrom ? `start_year = ${opt.yearFrom}` : 'không' });
    if (!keys.ieee) { r.error = 'chưa có IEEE API key (Cài đặt) — bỏ qua nguồn này'; return r; }
    const q = Core.translate.boolean(ast);
    r.sent.push(q);
    let start = 1;
    for (;;) {
      const p = new URLSearchParams({ querytext: q, apikey: keys.ieee, format: 'json', max_records: '200', start_record: String(start), sort_field: 'article_number', sort_order: 'asc' });
      if (opt.yearFrom) p.set('start_year', String(opt.yearFrom));
      const data = await http.get('https://ieeexploreapi.ieee.org/api/v1/search/articles?' + p.toString(), { label: 'IEEE Xplore' });
      if (r.reported === null) r.reported = data.total_records ?? null;
      const arts = data.articles || [];
      for (const a of arts) {
        if (r.records.length >= opt.max) break;
        r.records.push(Core.makeRecord(Object.assign({
          source: 'IEEE Xplore', title: a.title, authors: (((a.authors || {}).authors) || []).map(x => x.full_name),
          year: a.publication_year, venue: a.publication_title, doi: a.doi, abstract: a.abstract,
          url: a.doi ? 'https://doi.org/' + a.doi : (a.html_url || a.pdf_url), type: a.content_type,
          ids: { ieee: a.article_number },
        }, ctx.base)));
      }
      log(`IEEE Xplore: ${r.records.length}/${r.reported}`);
      start += 200;
      if (!arts.length || r.records.length >= opt.max || start > (r.reported || 0)) break;
      await sleep(1000);
    }
    if (r.reported > r.records.length) r.notes.push(`chỉ lấy ${r.records.length}/${r.reported} (giới hạn ${opt.max})`);
    return r;
  };

  adapters.arxiv = async function (ctx) {
    const { ast, opt, http, log } = ctx;
    let q = Core.translate.arxiv(ast);
    if (opt.yearFrom) q = `(${q}) AND submittedDate:[${opt.yearFrom}01010000 TO 209912312359]`;
    const r = result('arXiv', { field: 'all (mọi trường metadata)', filters: opt.yearFrom ? `submittedDate ≥ ${opt.yearFrom}` : 'không' });
    r.sent.push(q);
    r.notes.push('preprint — chưa bình duyệt, xét IC-T khi lọc');
    let start = 0;
    for (;;) {
      const p = new URLSearchParams({ search_query: q, start: String(start), max_results: '100' });
      const xml = await http.get('https://export.arxiv.org/api/query?' + p.toString(), { label: 'arXiv', as: 'text' });
      const doc = ctx.parseXML(xml);
      const tot = doc.getElementsByTagNameNS('*', 'totalResults')[0];
      if (r.reported === null) r.reported = tot ? Number(tot.textContent) : null;
      const entries = [...doc.getElementsByTagNameNS('*', 'entry')];
      const txt = (el, tag) => { const x = el.getElementsByTagNameNS('*', tag)[0]; return x ? x.textContent.trim() : ''; };
      for (const e of entries) {
        if (r.records.length >= opt.max) break;
        const absUrl = txt(e, 'id');
        r.records.push(Core.makeRecord(Object.assign({
          source: 'arXiv', title: txt(e, 'title'),
          authors: [...e.getElementsByTagNameNS('*', 'author')].map(a => txt(a, 'name')),
          year: (txt(e, 'published') || '').slice(0, 4), venue: txt(e, 'journal_ref') || 'arXiv',
          doi: txt(e, 'doi') || (absUrl ? '10.48550/arXiv.' + absUrl.split('/abs/').pop().replace(/v\d+$/, '') : ''),
          abstract: txt(e, 'summary'), url: absUrl, type: 'preprint',
          ids: { arxiv: absUrl.split('/abs/').pop() },
        }, ctx.base)));
      }
      log(`arXiv: ${r.records.length}/${r.reported}`);
      start += 100;
      if (!entries.length || r.records.length >= opt.max || start >= (r.reported || 0)) break;
      await sleep(3100); // arXiv yêu cầu ≥ 3 giây giữa các request
    }
    if (r.reported > r.records.length) r.notes.push(`chỉ lấy ${r.records.length}/${r.reported} (giới hạn ${opt.max})`);
    return r;
  };

  adapters.crossref = async function (ctx) {
    const { ast, opt, keys, http, log } = ctx;
    const kl = Core.keywordLines(ast, opt.lineCap || 30);
    const r = result('Crossref', { field: 'query.bibliographic (xếp theo độ liên quan)', filters: opt.yearFrom ? `from-pub-date ${opt.yearFrom}-01-01` : 'không' });
    r.notes.push(`Crossref không hỗ trợ boolean → tách ${kl.total} dòng từ khoá${kl.truncated ? ` (chỉ chạy ${kl.lines.length} dòng đầu)` : ''}, mỗi dòng lấy ${opt.perLine} kết quả liên quan nhất`);
    let reported = 0;
    for (const line of kl.lines) {
      const p = new URLSearchParams({ 'query.bibliographic': line, rows: String(opt.perLine), select: 'DOI,title,author,issued,container-title,abstract,URL,type,language' });
      if (opt.yearFrom) p.set('filter', `from-pub-date:${opt.yearFrom}-01-01`);
      if (keys.mailto) p.set('mailto', keys.mailto);
      const data = await http.get('https://api.crossref.org/works?' + p.toString(), { label: 'Crossref' });
      const msg = data.message || {};
      reported += msg['total-results'] || 0;
      r.sent.push(line);
      for (const it of msg.items || []) {
        r.records.push(Core.makeRecord(Object.assign({
          source: 'Crossref', title: (it.title || [])[0], authors: (it.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')),
          year: (((it.issued || {})['date-parts'] || [[]])[0] || [])[0], venue: (it['container-title'] || [])[0],
          doi: it.DOI, abstract: it.abstract, url: it.URL, type: it.type, language: it.language,
        }, ctx.base, { query: line })));
      }
      log(`Crossref: dòng "${line}" → ${(msg.items || []).length}`);
      await sleep(400);
    }
    r.reported = reported;
    r.notes.push('số "nguồn báo" của Crossref là tổng khớp lỏng theo từ khoá, không dùng cho PRISMA');
    return r;
  };

  adapters.dblp = async function (ctx) {
    const { ast, opt, http, log } = ctx;
    const kl = Core.keywordLines(ast, opt.lineCap || 30);
    const r = result('dblp', { field: 'tiêu đề (dblp không có abstract)', filters: opt.yearFrom ? `year ≥ ${opt.yearFrom} (lọc sau khi lấy)` : 'không' });
    r.notes.push(`dblp không hỗ trợ boolean đầy đủ → tách ${kl.total} dòng từ khoá${kl.truncated ? ` (chỉ chạy ${kl.lines.length} dòng đầu)` : ''}; không có abstract`);
    let reported = 0;
    for (const line of kl.lines) {
      const p = new URLSearchParams({ q: line, format: 'json', h: String(opt.perLine), f: '0' });
      const data = await http.get('https://dblp.org/search/publ/api?' + p.toString(), { label: 'dblp' });
      const hits = ((data.result || {}).hits) || {};
      reported += Number(hits['@total'] || 0);
      r.sent.push(line);
      for (const h of [].concat(hits.hit || [])) {
        const i = h.info || {};
        if (opt.yearFrom && Number(i.year) < Number(opt.yearFrom)) continue;
        const au = [].concat(((i.authors || {}).author) || []).map(a => (typeof a === 'string' ? a : a.text));
        r.records.push(Core.makeRecord(Object.assign({
          source: 'dblp', title: i.title, authors: au, year: i.year, venue: i.venue, doi: i.doi,
          url: i.doi ? 'https://doi.org/' + i.doi : (i.ee || i.url), type: i.type,
        }, ctx.base, { query: line })));
      }
      log(`dblp: dòng "${line}" → ${[].concat(hits.hit || []).length}`);
      await sleep(1000);
    }
    r.reported = reported;
    return r;
  };

  adapters.scholar = async function (ctx) {
    const { ast, opt, keys, http, log } = ctx;
    const r = result('Google Scholar (SerpAPI)', { field: 'Google Scholar', filters: opt.yearFrom ? `as_ylo = ${opt.yearFrom}` : 'không' });
    r.notes.push('không đếm vào PRISMA (review-protocol §3); dữ liệu qua dịch vụ bên thứ ba SerpAPI; không có DOI/abstract đầy đủ');
    if (!keys.serpapi) { r.error = 'chưa có SerpAPI key (Cài đặt) — bỏ qua nguồn này'; return r; }
    const q = Core.translate.scholar(ast);
    r.sent.push(q);
    let credits = 0;
    for (let page = 0; page < opt.scholarPages; page++) {
      const p = new URLSearchParams({ engine: 'google_scholar', q, num: '20', start: String(page * 20), api_key: keys.serpapi });
      if (opt.yearFrom) p.set('as_ylo', String(opt.yearFrom));
      const data = await http.get('https://serpapi.com/search.json?' + p.toString(), { label: 'SerpAPI' });
      credits++;
      if (data.error) throw new Error('SerpAPI: ' + data.error);
      if (r.reported === null) r.reported = ((data.search_information || {}).total_results) ?? null;
      const items = data.organic_results || [];
      for (const it of items) {
        const pi = it.publication_info || {};
        const summ = pi.summary || '';
        const yr = (summ.match(/\b(19|20)\d{2}\b/) || [])[0] || '';
        const parts = summ.split(' - ');
        r.records.push(Core.makeRecord(Object.assign({
          source: 'Google Scholar (SerpAPI)', title: it.title,
          authors: (pi.authors || []).map(a => a.name).concat((pi.authors || []).length ? [] : (parts[0] || '').split(',').map(s => s.trim())),
          year: yr, venue: (parts[1] || '').replace(/,?\s*(19|20)\d{2}.*$/, '').trim(),
          abstract: it.snippet, url: it.link, type: it.type || '', countsInPrisma: false,
          ids: { scholar: it.result_id },
        }, ctx.base)));
      }
      log(`SerpAPI Scholar: trang ${page + 1} → ${items.length} (đã dùng ${credits} lượt)`);
      if (items.length < 20) break;
      await sleep(1000);
    }
    r.notes.push(`đã dùng ${credits} lượt search SerpAPI`);
    return r;
  };

  // Springer Nature Meta API v2 (cần API key miễn phí từ dev.springernature.com)
  function springerAbstract(a) {
    if (!a) return '';
    if (typeof a === 'string') return a;
    if (Array.isArray(a)) return a.map(springerAbstract).join(' ');
    if (typeof a === 'object') return a.p !== undefined ? springerAbstract(a.p) : Object.entries(a).filter(([k]) => !/^h\d$/.test(k)).map(([, v]) => springerAbstract(v)).join(' ');
    return String(a);
  }
  adapters.springer = async function (ctx) {
    const { ast, opt, keys, http, log } = ctx;
    const r = result('Springer Nature', { field: 'q (metadata Springer Nature)', filters: opt.yearFrom ? `year ≥ ${opt.yearFrom} (lọc sau khi lấy)` : 'không' });
    r.notes.push('ngoài 3 nguồn đếm PRISMA của protocol — hỏi PL trước khi đếm');
    if (!keys.springer) { r.error = 'chưa có Springer Nature API key (Cài đặt) — bỏ qua nguồn này'; return r; }
    const q = Core.translate.boolean(ast);
    r.sent.push(q);
    const PAGE = 25;
    let start = 1, skippedOld = 0, pages = 0;
    for (;;) {
      const p = new URLSearchParams({ q, api_key: keys.springer, s: String(start), p: String(PAGE) });
      const data = await http.get('https://api.springernature.com/meta/v2/json?' + p.toString(), { label: 'Springer Nature' });
      pages++;
      const info = (data.result || [])[0] || {};
      if (r.reported === null) r.reported = info.total !== undefined ? Number(info.total) : null;
      const recs = data.records || [];
      for (const it of recs) {
        if (r.records.length >= opt.max) break;
        const yr = String(it.publicationDate || it.onlineDate || '').slice(0, 4);
        if (opt.yearFrom && yr && Number(yr) < Number(opt.yearFrom)) { skippedOld++; continue; }
        const urls = [].concat(it.url || []);
        const html = urls.find(u => u.format === 'html') || urls[0] || {};
        r.records.push(Core.makeRecord(Object.assign({
          source: 'Springer Nature', title: it.title,
          authors: [].concat(it.creators || []).map(c => (typeof c === 'string' ? c : c.creator)),
          year: yr, venue: it.publicationName || '', doi: it.doi, abstract: springerAbstract(it.abstract),
          url: it.doi ? 'https://doi.org/' + it.doi : html.value, type: it.contentType || '', language: it.language || '',
        }, ctx.base)));
      }
      log(`Springer Nature: ${r.records.length}/${r.reported} (trang ${pages})`);
      start += PAGE;
      if (!recs.length || r.records.length >= opt.max || start > (r.reported || 0)) break;
      await sleep(700); // gói miễn phí giới hạn số request mỗi phút
    }
    if (skippedOld) r.notes.push(`bỏ ${skippedOld} bản ghi trước năm ${opt.yearFrom} (Springer không lọc năm trong query)`);
    if (r.reported > r.records.length + skippedOld) r.notes.push(`chỉ duyệt ${r.records.length + skippedOld}/${r.reported} (giới hạn ${opt.max})`);
    return r;
  };

  // ---------- Snowballing ----------
  // OpenAlex: lùi = referenced_works của seed; tiến = filter cites:<seed>
  async function oaWorkByDoi(http, keys, doi) {
    const p = new URLSearchParams({ select: OA_SELECT });
    if (keys.openalex) p.set('api_key', keys.openalex);
    if (keys.mailto) p.set('mailto', keys.mailto);
    return http.get(`https://api.openalex.org/works/doi:${encodeURI(doi)}?` + p.toString(), { label: 'OpenAlex seed' });
  }

  async function snowOpenAlex(ctx, seedDoi, direction) {
    const { http, keys, opt, log } = ctx;
    const r = result('OpenAlex', { seed: seedDoi, direction: direction === 'back' ? 'lùi' : 'tiến' });
    const base = Object.assign({}, ctx.base, { snowball: direction === 'back' ? 'snowball-back' : 'snowball-fwd', seed: seedDoi });
    const seed = await oaWorkByDoi(http, keys, seedDoi);
    const wid = String(seed.id || '').split('/').pop();
    if (direction === 'back') {
      const refs = (seed.referenced_works || []).map(u => u.split('/').pop());
      r.reported = refs.length;
      r.notes.push(`OpenAlex ghi nhận ${refs.length} tài liệu tham khảo của seed`);
      for (let i = 0; i < refs.length; i += 50) {
        const chunk = refs.slice(i, i + 50);
        const p = new URLSearchParams({ filter: 'openalex_id:' + chunk.join('|'), 'per-page': '50', select: OA_SELECT });
        if (keys.openalex) p.set('api_key', keys.openalex);
        if (keys.mailto) p.set('mailto', keys.mailto);
        const data = await http.get('https://api.openalex.org/works?' + p.toString(), { label: 'OpenAlex refs' });
        for (const w of data.results || []) r.records.push(mapOpenAlex(w, base));
        log(`OpenAlex lùi ${seedDoi}: ${r.records.length}/${refs.length}`);
      }
    } else {
      let cursor = '*';
      const filt = [`cites:${wid}`];
      if (opt.yearFrom) filt.push(`publication_year:>${Number(opt.yearFrom) - 1}`);
      r.filters = opt.yearFrom ? `year ≥ ${opt.yearFrom}` : '';
      while (cursor && r.records.length < opt.max) {
        const p = new URLSearchParams({ filter: filt.join(','), 'per-page': '200', cursor, select: OA_SELECT });
        if (keys.openalex) p.set('api_key', keys.openalex);
        if (keys.mailto) p.set('mailto', keys.mailto);
        const data = await http.get('https://api.openalex.org/works?' + p.toString(), { label: 'OpenAlex cites' });
        if (r.reported === null) r.reported = (data.meta || {}).count ?? null;
        for (const w of data.results || []) r.records.push(mapOpenAlex(w, base));
        cursor = (data.meta || {}).next_cursor;
        log(`OpenAlex tiến ${seedDoi}: ${r.records.length}/${r.reported}`);
      }
    }
    r.fetched = r.records.length;
    return r;
  }

  async function snowS2(ctx, seedDoi, direction) {
    const { http, keys, opt, log } = ctx;
    const r = result('Semantic Scholar', { seed: seedDoi, direction: direction === 'back' ? 'lùi' : 'tiến' });
    const base = Object.assign({}, ctx.base, { snowball: direction === 'back' ? 'snowball-back' : 'snowball-fwd', seed: seedDoi });
    const headers = keys.s2 ? { 'x-api-key': keys.s2 } : {};
    const ep = direction === 'back' ? 'references' : 'citations';
    const key = direction === 'back' ? 'citedPaper' : 'citingPaper';
    let offset = 0;
    for (;;) {
      const p = new URLSearchParams({ fields: S2_FIELDS, limit: '1000', offset: String(offset) });
      const data = await http.get(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURI(seedDoi)}/${ep}?` + p.toString(), { headers, label: 'Semantic Scholar ' + ep });
      const items = (data.data || []).map(x => x[key]).filter(x => x && x.title);
      for (const pp of items) {
        if (direction === 'fwd' && opt.yearFrom && pp.year && pp.year < Number(opt.yearFrom)) continue;
        r.records.push(mapS2(pp, base));
      }
      log(`S2 ${direction === 'back' ? 'lùi' : 'tiến'} ${seedDoi}: ${r.records.length}`);
      if (data.next === undefined || data.next === null || r.records.length >= opt.max) break;
      offset = data.next;
      await sleep(keys.s2 ? 1100 : 3000);
    }
    r.reported = r.records.length;
    r.fetched = r.records.length;
    r.notes.push('S2 dùng để hỗ trợ snowballing; số tính vào hộp Snowballing của PRISMA là số bạn tick "thêm vào 01"');
    return r;
  }

  // Crossref: chỉ hướng lùi — danh sách reference mà nhà xuất bản (Springer, IEEE, ACM, Elsevier…) gửi lên Crossref
  async function snowCrossref(ctx, seedDoi, direction) {
    const { http, keys, log } = ctx;
    const r = result('Crossref', { seed: seedDoi, direction: direction === 'back' ? 'lùi' : 'tiến' });
    if (direction !== 'back') {
      r.notes.push('Crossref không cung cấp công khai danh sách bài trích dẫn (hướng tiến) — dùng OpenAlex/S2');
      return r;
    }
    const base = Object.assign({}, ctx.base, { snowball: 'snowball-back', seed: seedDoi });
    const mt = keys.mailto ? '?mailto=' + encodeURIComponent(keys.mailto) : '';
    const data = await http.get(`https://api.crossref.org/works/${encodeURI(seedDoi)}${mt}`, { label: 'Crossref seed' });
    const refs = ((data.message || {}).reference) || [];
    r.reported = refs.length;
    if (!refs.length) { r.notes.push('nhà xuất bản không gửi danh sách reference lên Crossref cho bài này'); return r; }
    const withDoi = refs.filter(x => x.DOI).map(x => Core.normDoi(x.DOI));
    const meta = new Map();
    for (let i = 0; i < withDoi.length; i += 40) {
      const chunk = withDoi.slice(i, i + 40);
      const p = new URLSearchParams({ filter: chunk.map(d => 'doi:' + d).join(','), rows: '100', select: 'DOI,title,author,issued,container-title,abstract,URL,type,language' });
      if (keys.mailto) p.set('mailto', keys.mailto);
      const d2 = await http.get('https://api.crossref.org/works?' + p.toString(), { label: 'Crossref refs' });
      for (const it of ((d2.message || {}).items) || []) meta.set(Core.normDoi(it.DOI), it);
      await sleep(400);
    }
    for (const ref of refs) {
      const it = ref.DOI ? meta.get(Core.normDoi(ref.DOI)) : null;
      if (it) {
        r.records.push(Core.makeRecord(Object.assign({
          source: 'Crossref', title: (it.title || [])[0], authors: (it.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')),
          year: (((it.issued || {})['date-parts'] || [[]])[0] || [])[0], venue: (it['container-title'] || [])[0],
          doi: it.DOI, abstract: it.abstract, url: it.URL, type: it.type, language: it.language,
        }, base)));
      } else {
        const title = ref['article-title'] || ref['volume-title'] || ref.unstructured || '';
        if (!title) continue;
        r.records.push(Core.makeRecord(Object.assign({
          source: 'Crossref', title, authors: ref.author ? [ref.author] : [], year: ref.year, venue: ref['journal-title'] || '',
          doi: ref.DOI || '', type: ref.unstructured && !ref['article-title'] ? 'reference (chưa tách)' : '',
        }, base)));
      }
    }
    const noDoi = refs.length - withDoi.length;
    r.notes.push(`${refs.length} reference (${withDoi.length} có DOI${noDoi ? `, ${noDoi} không DOI → lấy tiêu đề/chuỗi trích dẫn thô` : ''})`);
    log(`Crossref lùi ${seedDoi}: ${r.records.length}/${refs.length}`);
    r.fetched = r.records.length;
    return r;
  }

  const NAMES = { openalex: 'OpenAlex', s2: 'Semantic Scholar', ieee: 'IEEE Xplore', arxiv: 'arXiv', crossref: 'Crossref', dblp: 'dblp', scholar: 'Google Scholar (SerpAPI)', springer: 'Springer Nature' };

  // ---------- Chạy một lượt ----------
  async function runSearch({ query, sources, opt, keys, fetchImpl, log, stopFlag, parseXML, label }) {
    const ast = Core.parse(query);
    const http = makeHttp(fetchImpl, log, stopFlag);
    const when = nowStamp();
    const base = { run: label, fetchedAt: when, query: Core.translate.boolean(ast) };
    const run = { kind: 'search', label, when, query, sources: [], records: [] };
    for (const name of sources) {
      if (stopFlag && stopFlag.stop) break;
      const ad = adapters[name];
      let r;
      log(`▶ ${name}: bắt đầu`);
      try {
        r = await ad({ ast, opt: Object.assign({}, opt), keys, http, log, base, parseXML });
      } catch (e) {
        r = result(NAMES[name] || name, { error: e.message });
        log(`✖ ${name}: ${e.message}`);
      }
      r.fetched = r.records.length;
      run.sources.push(Object.assign({}, r, { records: undefined }));
      run.records.push(...r.records);
      log(`✔ ${r.name}: lấy ${r.fetched}${r.reported !== null ? '/' + r.reported : ''}${r.error ? ' — ' + r.error : ''}`);
    }
    return run;
  }

  async function runSnowball({ seeds, directions, via, opt, keys, fetchImpl, log, stopFlag, label, round }) {
    const http = makeHttp(fetchImpl, log, stopFlag);
    const when = nowStamp();
    const run = { kind: 'snowball', label, round, when, sources: [], records: [] };
    for (const raw of seeds) {
      const seed = Core.normDoi(raw);
      if (!seed) continue;
      for (const dir of directions) for (const v of via) {
        if (stopFlag && stopFlag.stop) return run;
        const base = { run: label, fetchedAt: when };
        let r;
        try {
          r = await ({ openalex: snowOpenAlex, s2: snowS2, crossref: snowCrossref }[v])({ http, keys, opt, log, base }, seed, dir);
        } catch (e) {
          r = result(NAMES[v] || v, { seed, direction: dir === 'back' ? 'lùi' : 'tiến', error: e.message });
          log(`✖ ${v} ${dir} ${seed}: ${e.message}`);
        }
        r.fetched = r.records.length;
        run.sources.push(Object.assign({}, r, { records: undefined }));
        run.records.push(...r.records);
      }
    }
    return run;
  }

  function preview(query, opt) {
    const ast = Core.parse(query);
    const kl = Core.keywordLines(ast, (opt && opt.lineCap) || 30);
    return {
      'OpenAlex / IEEE Xplore / Springer Nature': Core.translate.boolean(ast),
      'Semantic Scholar (bulk)': Core.translate.s2(ast),
      'arXiv': (() => { try { return Core.translate.arxiv(ast); } catch (e) { return '⚠ ' + e.message; } })(),
      'Google Scholar (SerpAPI)': Core.translate.scholar(ast),
      ['Crossref / dblp — ' + kl.total + ' dòng từ khoá' + (kl.truncated ? ' (chạy ' + kl.lines.length + ' dòng đầu)' : '')]: kl.lines.join('\n'),
    };
  }

  const Sources = { lastRequests, adapters, makeHttp, runSearch, runSnowball, preview, nowStamp };
  root.Sources = Sources;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sources;
})(typeof self !== 'undefined' ? self : globalThis);
