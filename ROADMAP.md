# Roadmap — GBFR Local Translator

Tài liệu này mô tả hướng phát triển công khai của **GBFR Local Translator**. Roadmap là định hướng kỹ thuật, không phải cam kết thời gian phát hành.

## Nguyên tắc xuyên suốt

- Không đưa dữ liệu trích xuất từ game, corpus dịch thật, asset, font hoặc nội dung có bản quyền vào repository.
- Raw source và định danh dòng phải bất biến; bản dịch đi qua overlay/checkpoint thay vì sửa nguồn không kiểm soát.
- AI tạo candidate, không tự quyết định nội dung đã được duyệt.
- `LOCAL_OK` chỉ có nghĩa là đạt QA kỹ thuật; nội dung cốt truyện, lore, xưng hô và các bề mặt quan trọng vẫn cần người duyệt.
- Không gọi một bản là `final`, `RC` hoặc bản Việt hóa hoàn chỉnh khi chưa qua kiểm thử trong game và rollback.
- Mọi release phải có version, changelog, checksum và giới hạn đã biết.

## Giai đoạn 1 — Public repository foundation

**Trạng thái:** đang hoàn thiện.

Mục tiêu là biến repository thành nền phát hành có thể kiểm chứng và đóng góp lâu dài.

- Story Complete Worker v1.8 có mã nguồn công khai.
- README, kiến trúc, input format, troubleshooting và release process.
- MIT license, third-party notice, security/privacy policy.
- Test bằng dữ liệu tổng hợp và GitHub Actions CI.
- Issue template, contribution guide và checksum cho archive phát hành.
- Không chứa corpus hoặc dữ liệu runtime riêng của dự án.

## Giai đoạn 2 — Harden Translation Worker

Mục tiêu là làm Worker ổn định hơn trước khi mở rộng phạm vi dịch.

- Mở rộng regression fixtures cho placeholder, số, protected term, CJK leak và structured output.
- Kiểm tra config/schema trước khi chạy corpus lớn.
- Bổ sung privacy scan tự động cho cây public và release archive.
- Chuẩn hóa manifest/checksum cho mọi bản phát hành.
- Kiểm thử resume/checkpoint sau forced shutdown và thay đổi version.
- Tách rõ lỗi kỹ thuật, lỗi ngôn ngữ và lỗi do model/runtime.

## Giai đoạn 3 — Hybrid translation pipeline

Mục tiêu là dùng nhiều tầng AI theo vai trò riêng thay vì một model tự dịch và tự duyệt chính nó.

Kiến trúc đang được thử nghiệm:

1. TranslateGemma tạo phương án dịch ban đầu.
2. Qwen biên tập dựa trên English/Japanese và glossary.
3. Deterministic QA khóa token, số, placeholder, line structure và protected terms.
4. Qwen critic/repair xử lý các candidate cần sửa.
5. Candidate còn rủi ro được chuyển sang human review thay vì tự phê duyệt.

Phần này chỉ được đưa vào nhánh ổn định khi test hồi quy, dữ liệu contract và behavior khi fallback đều đạt yêu cầu.

## Giai đoạn 4 — Exact-line Context Layer

Mục tiêu là giảm dịch sai ngữ cảnh mà không đổ toàn bộ database vào prompt.

- Truy xuất context theo exact key: `File + Row + ID + SubID`.
- Tách các câu giống nhau nhưng xuất hiện ở scene khác nhau bằng context fingerprint.
- Khóa các dòng `DO_NOT_RETRANSLATE` khỏi AI.
- Không sử dụng quan hệ hoặc thông tin từ scene xảy ra sau thời điểm của câu đang dịch.
- Dataset contract khóa số dòng, thứ tự, ID, English và Japanese trước/sau pipeline.
- Context Database thật tiếp tục nằm ngoài repository; test công khai chỉ dùng fixture tổng hợp.

## Giai đoạn 5 — In-game P0 validation

Một candidate kỹ thuật chưa phải release chỉ vì test code PASS.

Cổng P0 dự kiến yêu cầu bằng chứng tối thiểu cho:

- cài đặt;
- boot game;
- main menu;
- UI đã dịch;
- combat HUD;
- uninstall;
- rollback.

Bên cạnh P0, các nhóm story/lore và nội dung ngữ nghĩa quan trọng phải được human-review trước khi candidate được xem là sẵn sàng phát hành.

## Giai đoạn 6 — Community-ready releases

Mục tiêu dài hạn là phát hành tool theo quy trình có thể lặp lại:

- semantic versioning rõ ràng;
- GitHub Release + checksum;
- migration note khi checkpoint/input contract thay đổi;
- changelog và known issues;
- archive sạch, không chứa dữ liệu game hay dữ liệu người dùng;
- hướng dẫn update, uninstall và rollback;
- playtest report cho các bề mặt P0.

## Ngoài phạm vi repository

Repository này không nhằm phân phối:

- game hoặc file trích xuất từ game;
- patch chứa nội dung có bản quyền của nhà phát hành;
- corpus Việt hóa đầy đủ;
- model AI của bên thứ ba;
- font hoặc asset game;
- dữ liệu/log riêng của người dùng.

## Định nghĩa “hoàn tất”

Một phiên bản tool có thể được xem là ổn định khi test và release contract đạt yêu cầu. Một **bản Việt hóa hoàn chỉnh** chỉ có thể được tuyên bố sau khi đồng thời đạt QA kỹ thuật, QA ngôn ngữ/ngữ cảnh, build/round-trip, kiểm tra font/UI và playtest thực tế trong game.
