# RBL Paper Harvester (extension Chrome)

Tìm paper trên nhiều nguồn bằng **một chuỗi tìm**, snowballing tự động, bỏ trùng, rồi xuất `01_all_records.csv` đúng format nhóm và đoạn log để dán vào `search-log.md`.

| Nguồn | Cách lấy | Đếm vào PRISMA? | Ghi chú |
|---|---|---|---|
| OpenAlex | API chính thức | Có | Cần API key miễn phí (bắt buộc từ 02/2026). Chọn được trường `title-abstract` hoặc mặc định |
| IEEE Xplore | API chính thức | Có | Cần API key (đăng ký miễn phí ở developer.ieee.org) |
| Semantic Scholar | API chính thức (bulk search) | Không (review-protocol §3) | Key tuỳ chọn; không key dễ gặp HTTP 429 |
| arXiv | API chính thức | Tuỳ nhóm (preprint, xét IC-T) | Tự chờ 3 giây giữa các request |
| Crossref | API chính thức | Không nên | Không hỗ trợ boolean → tool tách chuỗi thành các dòng từ khoá |
| dblp | API chính thức | Không nên | Không có abstract; tách dòng từ khoá như Crossref |
| Google Scholar | **SerpAPI** (bên thứ ba, tốn lượt) | Không (review-protocol §3) | Mỗi trang 20 kết quả = 1 lượt SerpAPI |
| Springer Nature | API chính thức (Meta API v2) | Ngoài protocol — hỏi PL | Cần API key miễn phí (dev.springernature.com); gói miễn phí giới hạn số lượt/ngày; Springer không lọc năm trong query nên tool lọc sau khi lấy |

ACM Digital Library **không có API**, và chính sách của ACM cấm dùng script/robot cào metadata (vi phạm có thể làm **cả trường** bị khoá quyền tải). Tool **không cào ACM**; thay vào đó nhập file export từ web (mục 1b).

## Cài đặt (1 lần)

1. Mở Chrome → gõ `chrome://extensions` → bật **Developer mode** (góc phải trên).
2. Bấm **Load unpacked** → chọn thư mục `rbl-paper-harvester` này.
3. Bấm biểu tượng 🧩 trên thanh công cụ → ghim **RBL Paper Harvester** → bấm vào để mở giao diện.
4. Vào tab **Cài đặt API key**, nhập key, bấm **Lưu key**. Key chỉ nằm trong bộ nhớ trình duyệt, không ghi ra file.

## Cách dùng

**1. Search**
- Dán chuỗi tìm dạng `(P) AND (I) AND (O)`, cụm nhiều từ đặt trong `"…"`.
- Bấm **Xem chuỗi dịch cho từng nguồn** để kiểm tra trước. Đây cũng là chuỗi sẽ được ghi vào log.
- Đặt **nhãn lần chạy** (ví dụ `V7`), chọn nguồn, bấm **Chạy search**.
- Nguồn nào lỗi (thiếu key, HTTP lỗi, 429 quá 5 lần) sẽ hiện ❌ trong nhật ký và trong log, **không bị bỏ qua im lặng**.

**1b. ACM Digital Library (nhập file export)**
> Chỉ làm được khi tài khoản ACM có **Premium** (đăng ký của trường hoặc hội viên). Bản Basic miễn phí không cho Export Citations và Advanced Search. Người không có Premium nhờ người có quyền export file .bib rồi nhập vào đây.

1. Ở tab Search, bấm **Mở ACM DL với chuỗi này** (tool mở trang tìm của ACM với chuỗi ở trên, `AllField`, từ năm IC-Y). Nếu PL tìm theo trường Abstract/Title thì chỉnh trong Advanced Search của ACM cho giống, rồi dán chuỗi thật vào ô *Chuỗi đã dùng trên ACM*.
2. Ghi **Số kết quả ACM báo** vào ô tương ứng.
3. Trên ACM: **Export Citations → tab "All results" → BibTeX → tải về**.
4. Chọn file `.bib` (được chọn nhiều file) → **Nhập file ACM**. Bản ghi có nguồn `ACM DL`, được đếm PRISMA, có abstract và số trang nếu file có (số trang < 4 → gợi ý EC-S). Nếu số mục trong file khác số ACM báo, log tự ghi ⚠ lệch.

## Quy trình PRISMA đầy đủ (v1.4)

```
Nhánh 1: Search (tab 1) → bỏ trùng → V1 (tab 4) → V2 (tab 4) → INCLUDE
                                                                  │ làm seed
Nhánh 2: Snowballing vòng 1 (tab 2: "Điền seed vòng 1") → lùi + tiến (từ năm 2020) → bỏ trùng → V1 → V2 → INCLUDE
                                                                  │ làm seed
         Snowballing vòng 2 (tab 2: "Điền seed vòng 2") → lùi + tiến → bỏ trùng → V1 → V2 → INCLUDE
Tab 5: prisma-flow.md tự đếm cả 2 nhánh + kiểm cộng trừ; xuất 01 / 02 / 03 đúng header của nhóm
```

- **Mã K cố định**: cấp khi bài vào 01 (đã tick), không đổi về sau, dùng chung cho 01/02/03 và prisma-flow.
- **Tab 4 Screening**: V1 = mọi bài trong 01 (INCLUDE / EXCLUDE / Unsure); V2 = bài INCLUDE + Unsure ở V1 (INCLUDE / EXCLUDE). Chọn mã lý do (mã đầu tiên = mã chính), ghi chú tuỳ ý. Bấm lại nút đang chọn để bỏ chọn. Tự lưu.
- **Hướng snowballing**: cột "Nhánh / hướng / seed" ở tab 3 và đầu mỗi thẻ ở tab 4: `← LÙI` = bài nằm trong references của seed, `→ TIẾN` = bài trích dẫn seed, kèm mã K của seed. Lọc được theo nhánh/hướng.
- **Bài trước năm "Chỉ lấy bài từ năm" không được lấy ở cả hai hướng**; log ghi số reference bị bỏ.
- Bài snowballing mặc định **được đưa vào 01** để đi qua V1 (đúng PRISMA: mọi bài tìm được đều có quyết định + lý do). Bỏ tick ở tab 3 nếu muốn ghi là "lướt tiêu đề, không thêm vào 01".
- **Sao lưu / khôi phục** (tab 5): trạng thái screening chỉ nằm trong trình duyệt, nên sao lưu file .json sau mỗi buổi làm và commit cùng repo.

**2. Snowballing**
- Nhập DOI seed, mỗi dòng một DOI. Theo RBL-1, seed **chỉ là paper đã INCLUDE ở vòng 2**.
- Chọn hướng (lùi/tiến) và API (OpenAlex, Semantic Scholar, Crossref), bấm **Chạy snowballing**.
- **Crossref chỉ làm được hướng lùi**: lấy danh sách reference mà nhà xuất bản (Springer, IEEE, ACM…) gửi lên Crossref. Reference không có DOI được ghi bằng tiêu đề hoặc chuỗi trích dẫn thô. Springer Nature API không có dữ liệu trích dẫn, nên snowballing bài Springer đi qua OpenAlex / Semantic Scholar / Crossref.
- Từ v1.4 bài snowballing mặc định **được tick** (vào 01 → screening V1). Dùng nút "Điền seed vòng 1/2" để lấy seed tự động từ bài INCLUDE (V2).

**3. Kết quả & Xuất**
- Bảng đã **bỏ trùng** theo DOI. Bản ghi không có DOI thì so tiêu đề chuẩn hoá. Cột "Nguồn" ghi mọi nguồn đã tìm ra bài đó.
- **Xuất 01_all_records.csv**: chỉ các bài đã tick, cột `ma, nguon, phien_ban, loai, doi, title, authors, year, venue, url, abstract` (giống file của nhóm) + `ngon_ngu, snowball, seed, query, ngay_lay`. Đặt tiền tố mã (vd `K`) và số bắt đầu (vd `8` nếu đã có K01–K07).
- **Xuất đoạn search-log.md**: bảng gồm chuỗi gửi đi nguyên văn, trường tìm, bộ lọc, ngày giờ, số kết quả nguồn báo, số lấy về, lỗi/ghi chú. Có thêm bảng snowballing và dòng tổng hợp dedup. Dán vào `search-log.md`.
- **Xuất dữ liệu thô (.json)**: lưu làm bằng chứng gốc (không chứa key).

## Sơ loại tự động (v1.2) — chỉ là gợi ý

Tab 3 có cột **Gợi ý**. Tool đọc **toàn bộ tiêu đề + abstract** (không chỉ tiêu đề) và đối chiếu bộ IC/EC của nhóm:

| Cờ | Ý nghĩa |
|---|---|
| ƯU TIÊN | thấy cả từ khoá REST API (IC-P) lẫn EP/BVA (IC-I) |
| XEM | thấy một trong hai |
| THIẾU ABSTRACT | chưa có abstract đầy đủ, chưa đủ cơ sở để gợi ý |
| ÍT KHẢ NĂNG | có abstract nhưng không thấy REST API lẫn EP/BVA |
| LOẠI? | trượt IC-Y (năm < mốc), IC-L (tiêu đề/abstract không phải tiếng Anh) hoặc EC-S (< 4 trang, khi có số trang) |

Từ khoá khớp được tô vàng ngay trong tiêu đề/abstract. Ghi chú kèm theo: EC-O? (thấy Selenium/E2E/GUI…), IC-E (abstract có số liệu hay chưa). Bấm vào đoạn abstract để mở rộng.

- **Thiếu DOI (Google Scholar)**: Scholar không trả DOI. Tool lấy DOI theo thứ tự:
  1. DOI nằm sẵn trong link bài (ACM, Springer, Wiley, arXiv…), không tốn request, làm ngay lúc cào;
  2. nút **Bổ sung abstract + DOI**: tra OpenAlex (theo DOI/tiêu đề) rồi Crossref (theo tiêu đề), chỉ nhận khi tiêu đề khớp và năm lệch ≤ 1;
  3. nút **Mở trang bài để tìm DOI còn thiếu**: mở từng trang bài (như bấm vào link), đọc thẻ meta `citation_doi`/`dc.identifier`/`prism.doi` (IEEE: metadata của trang). ~1,5 s/bài, tối đa 150 bài/lần, cần cấp quyền đọc trang web khi bấm lần đầu. Bỏ qua dl.acm.org, Google Books, ResearchGate, Academia, file PDF. Trang chặn bot hoặc cần đăng nhập sẽ ghi "bị chặn". Luận văn/kho lưu trữ của trường thường **không có DOI**, đó là bình thường.
- **Bổ sung abstract còn thiếu**: bài từ Google Scholar chỉ có snippet, bài dblp không có abstract. Nút này tra OpenAlex theo DOI (hoặc theo tiêu đề nếu không có DOI, chỉ nhận khi tiêu đề khớp), chỉ ĐIỀN thêm dữ liệu, không ghi đè. Bài nguồn không có abstract thì vẫn là THIẾU ABSTRACT. Bài nào đã thử sẽ không tra lại.
- **Chỉ tick ƯU TIÊN + XEM**: lọc thô để đọc trước. Bài THIẾU ABSTRACT không được tick, hãy bổ sung abstract rồi tick lại.
- CSV xuất thêm 2 cột `goi_y_so_loai`, `tu_khoa_khop`.
- Đây **không** thay bước screening V1/V2 của RBL-1. Bạn vẫn phải tự đọc, điền INCLUDE/EXCLUDE/Unsure và mã IC/EC vào `02_after_screening_v1.csv`. Từ khoá chỉ bắt chữ có trong abstract, nên bài chỉ nói EP/BVA ở phần thân sẽ bị gắn XEM hoặc ÍT KHẢ NĂNG; bài đó chỉ xác định được khi đọc full-text (V2).

## Bắt buộc theo RBL-1 khi dùng công cụ tự viết

Ghi kết quả 3 phép kiểm sau vào `search-log.md`:
1. Số bản ghi tool lấy được khớp với số kết quả trang web của nguồn báo cho cùng query. Lệch thì phải giải thích được.
2. Mở ngẫu nhiên 5 bản ghi, đối chiếu tiêu đề, năm, DOI với trang gốc.
3. Chạy lại cùng query ra cùng số bản ghi, hoặc ghi rõ nguồn đã cập nhật.

## Giới hạn đã biết

- Crossref và dblp không hỗ trợ boolean. Tool tách chuỗi thành tối đa 30 dòng từ khoá (tổ hợp các term giữa các khối), nên kết quả nhiều nhiễu. Chỉ nên dùng để bổ sung.
- Google Scholar qua SerpAPI thường không có DOI và chỉ có đoạn trích (snippet), không có abstract đầy đủ. Bỏ trùng với nguồn khác dựa vào tiêu đề.
- Semantic Scholar bulk search có cú pháp riêng (`+` = AND, `|` = OR). Tool tự dịch, xem nút "Xem chuỗi dịch".
- Giới hạn "tối đa mỗi nguồn" (mặc định 500). Nếu nguồn báo nhiều hơn, log sẽ ghi "chỉ lấy X/Y".
