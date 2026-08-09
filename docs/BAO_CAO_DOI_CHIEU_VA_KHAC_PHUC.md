# Đối chiếu `Bao_Cao_So_Sanh_Quy_Trinh.md` và mã nguồn thực tế

## Kết luận điều hành

Báo cáo xác định đúng hai rủi ro lớn: thiếu rào chắn dataset và thiếu P0 test tích hợp. Tuy nhiên báo cáo đã nhầm kiến trúc ở ba điểm: Dynamic Context RAG chưa hề được nối vào production; tool đã có AI repair/checkpoint/fallback chứ không phải chỉ reject chờ sửa tay; screen mapping không phải điều kiện bắt buộc để pipeline production dịch một dòng.

Hướng sửa không phải bỏ QA để chạy nhanh. Candidate này ghép tốc độ của pipeline local với bốn invariant của hệ thống GBFR: source bất biến, exact-line context, human review cho nội dung trọng yếu và P0 evidence trước release.

## Ma trận đối chiếu

| Nhận định trong báo cáo | Bằng chứng từ code trước sửa | Kết luận | Khắc phục trong candidate |
|---|---|---|---|
| Có Dynamic Context RAG | Context Layer v1 tồn tại ở package riêng; `hybrid.mjs` không import/retrieve context | Chưa đúng | Nối exact-line context vào production prompt |
| AI tự sửa lỗi cho AI | `hybrid.mjs` có editor, critic, repair và safe fallback | Đúng một phần | Giữ repair, nhưng deterministic QA và human review vẫn là cổng độc lập |
| AI có thể đổi cấu trúc file | QA cũ khóa token/newline theo dòng nhưng không khóa toàn dataset | Đúng | Thêm dataset contract trước/sau production |
| Không có In-game P0 tích hợp | Không có module/evidence schema/release gate | Đúng | Thêm `release-gate.mjs` và template 7 kiểm tra P0 |
| GBFR trả lỗi về English rồi chờ sửa tay | Code có fallback kỹ thuật và repair nhiều lượt | Sai/khái quát hóa | Giữ fallback; route lỗi ngữ nghĩa sang review thay vì tự phê duyệt |
| Không có RAG động nên luôn dịch mù | Pilot Context Layer đã tồn tại nhưng chưa nối | Đúng về production cũ | Context chỉ cấp đúng record liên quan, không nhét toàn DB vào prompt |
| Đóng gói mỗi batch làm chậm | Packaging nằm ngoài translator core và đã có nhiều artifact lịch sử | Đúng ở cấp vận hành | Chỉ chạy release gate/manifest ở candidate phát hành, không ở mỗi batch nội bộ |
| Screen mapping chặn mọi dòng chưa biết màn hình | `runHybridProduction` không yêu cầu screen mapping | Không đúng | Không biến screen mapping thành blocker; dùng để ưu tiên test/coverage |
| Mọi lỗi cần Tý sửa tay | Chỉ `REVIEW_MANDATORY`, semantic risk và P0 cần người | Không đúng | Giữ người ở quyết định quan trọng, tự động hóa contract và QA cơ học |

## Các lỗi gốc đã khắc phục

### 1. Context không đi vào production

`translation-context.mjs` tải database tùy chọn, truy xuất đúng `File + Row + ID + SubID`, chỉ tạo `ContextPrompt` khi `queueDecision.allowed=true`. Dòng khóa và nguồn không đạt không lộ context vào model.

### 2. Gom nhóm làm mất ngữ cảnh

Signature cũ: `Category + English + Japanese + mandatoryReview`.

Signature mới thêm `contextFingerprint`. Cùng câu “Right.” ở hai scene khác nhau trở thành hai translation unit khác nhau.

### 3. Thiếu invariant toàn file

`contracts.mjs` khóa:

- Số dòng và thứ tự.
- `File`, `Row`, `ID`, `SubID`.
- English và Japanese nguyên bản.
- SHA-256 snapshot trước/sau.

Chỉ `Vietnamese`, Notes, status, provenance và QA được phép thay đổi.

### 4. P0 chỉ nằm trong hướng dẫn thủ công

Release gate yêu cầu đủ bằng chứng:

- Install.
- Boot.
- Main menu.
- Translated UI.
- Combat HUD.
- Uninstall.
- Rollback.

Thiếu một mục hoặc chưa human-approve thì exit code khác 0 và quyết định là `CHƯA PHÁT HÀNH`.

### 5. Codegraph dễ index nhầm artifact

Repository candidate có `.gitignore` và `codegraph.json` loại data corpus, MSG, ZIP, lịch sử run và dependencies. Graph chỉ mô tả code đang vận hành.

## Việc chưa được tuyên bố là hoàn tất

- Context Database production và bằng chứng video vẫn nằm ngoài repository; fixture GitHub không thay thế kiểm định dữ liệu thật.
- Chưa thực hiện P0 trong game; gate mới chỉ được dựng và test.
- Candidate GitHub-safe không chứa corpus, Context Database production hoặc artifact game.
- Candidate chưa phải Beta 5 phát hành và không được hợp nhất vào Golden Master khi chưa có xác nhận trong game.
