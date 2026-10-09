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

ACM Digital Library **không có API** → vẫn export trên web như hướng dẫn RBL-1.

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

**2. Snowballing**
- Nhập DOI seed, mỗi dòng một DOI. Theo RBL-1, seed **chỉ là paper đã INCLUDE ở vòng 2**.
- Chọn hướng (lùi/tiến) và API (OpenAlex, Semantic Scholar, Crossref), bấm **Chạy snowballing**.
- **Crossref chỉ làm được hướng lùi**: lấy danh sách reference mà nhà xuất bản (Springer, IEEE, ACM…) gửi lên Crossref. Reference không có DOI được ghi bằng tiêu đề hoặc chuỗi trích dẫn thô. Springer Nature API không có dữ liệu trích dẫn, nên snowballing bài Springer đi qua OpenAlex / Semantic Scholar / Crossref.
- Bài snowballing mặc định **không được tick**. Sang tab 3 lướt tiêu đề, tick bài có vẻ liên quan. Số bài đã tick chính là "Số thêm vào 01".

**3. Kết quả & Xuất**
- Bảng đã **bỏ trùng** theo DOI. Bản ghi không có DOI thì so tiêu đề chuẩn hoá. Cột "Nguồn" ghi mọi nguồn đã tìm ra bài đó.
- **Xuất 01_all_records.csv**: chỉ các bài đã tick, cột `ma, nguon, phien_ban, loai, doi, title, authors, year, venue, url, abstract` (giống file của nhóm) + `ngon_ngu, snowball, seed, query, ngay_lay`. Đặt tiền tố mã (vd `K`) và số bắt đầu (vd `8` nếu đã có K01–K07).
- **Xuất đoạn search-log.md**: bảng gồm chuỗi gửi đi nguyên văn, trường tìm, bộ lọc, ngày giờ, số kết quả nguồn báo, số lấy về, lỗi/ghi chú. Có thêm bảng snowballing và dòng tổng hợp dedup. Dán vào `search-log.md`.
- **Xuất dữ liệu thô (.json)**: lưu làm bằng chứng gốc (không chứa key).

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
