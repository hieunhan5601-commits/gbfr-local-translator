# Changelog

Tài liệu này ghi lại các thay đổi đáng chú ý của Story Complete Worker. Ngày tháng dùng múi giờ Việt Nam (UTC+7).

## [1.8] - 2026-08-12

### Fixed

- Loại false positive `TECHNICAL_TOKEN_MISMATCH` khi văn xuôi tiếng Việt xuất hiện sau dấu phần trăm, ví dụ `% dựa trên` bị hiểu nhầm thành printf token `% d`.
- Vẫn bảo vệ các printf token compact hợp lệ như `%d` và `%s`.
- Không kích hoạt `EARLY_RECOVERY_GROWTH` hoặc `UNRESOLVED_RATE_TOO_HIGH` sau khi batch dữ liệu mới cuối cùng đã chạy xong.

### Changed

- Các mục chưa đạt ở cuối fresh queue đi tiếp vào hàng cứu nhóm và cứu lẻ.
- Nếu mọi lượt cứu đều thất bại, mục được ghi `TECHNICAL_ERROR`; downstream phải giữ English source thay vì merge candidate lỗi.
- Structured Output gate và batch-wide failure gate vẫn được giữ nguyên.

### Verification

- Syntax check: PASS.
- Bộ hồi quy v1.4-v1.8: 11/11 test files PASS khi chạy tuần tự.
- ZIP hotfix trùng byte với cây build v1.8.

## [1.7] - 2026-08-12

### Fixed

- Nhận diện metadata tên diễn viên bằng exact `item.id` có tiền tố `TXT_CV_`.
- Giữ exact English cho 63 trường metadata này và không gửi chúng cho Qwen.
- Tự thêm metadata còn thiếu vào checkpoint và phục hồi checkpoint tên diễn viên đã bị model sửa.
- Sửa thông báo dừng để hiển thị đúng số mục còn lại.

### Safety

- `UNCHANGED_ENGLISH` vẫn áp dụng cho hội thoại/mô tả thông thường; không nới QA trên toàn corpus.

## [1.6] - 2026-08-12

### Fixed

- Đọc `story_failed_responses.jsonl` để nhận diện backlog từng thất bại nhưng chưa có checkpoint hợp lệ.
- Không tính backlog lịch sử vào fresh pilot.
- Một key đã có checkpoint hợp lệ không bị kéo lại chỉ vì từng có failure event.
- Lượt sửa `UNEXPECTED_CJK` chỉ nhận English source để tránh model sao chép chữ Nhật/Hán.
- Chuẩn hóa có giới hạn các alias `Gran Cypher`, `GranCypher`, `Grand Cypher` về `Grandcypher` khi source bắt buộc protected term này.

## [1.5] - 2026-08-12

### Fixed

- Phân biệt chuỗi rỗng (`EMPTY`) với key Structured Output bị thiếu.
- Structured failure chỉ được đếm khi vẫn chưa cứu được sau các lượt repair.
- Giữ dấu câu thuần túy như `...` theo deterministic rule.
- Chấp nhận âm thanh phi ngôn ngữ khi không có nội dung cần dịch.
- Chuẩn hóa so sánh hàng nghìn `5,000` và `5.000`.
- Không đưa candidate nhiễm CJK/English/protected-term lỗi trở lại prompt sửa.

## [1.4] - 2026-08-11

### Added

- Cơ chế sửa riêng ngay từng câu bị QA từ chối, tối đa hai lượt.
- Ghi cảnh báo `RECOVERED_AFTER_QA_REJECTION` cho câu được cứu.

### Changed

- Cổng an toàn đo tỷ lệ **chưa cứu được**, không đếm lỗi thô đã sửa thành công.
- Re-QA checkpoint theo rule hiện hành và đưa record không còn hợp lệ vào hàng dịch lại.
- Giữ Structured Output, batch tối đa 10 và chạy tuần tự.

## [1.3] - 2026-08-11

### Added

- Structured Output JSON Schema thay cho parser marker tự do.
- Pilot ít nhất 100 mục mới với ngưỡng đạt 98%.
- Dừng ngay khi một batch thất bại toàn bộ hoặc hàng lỗi tăng bất thường.
- Log `finish_reason`, key và nguyên nhân cho response lỗi.

### Changed

- Giảm batch tối đa về 10 và concurrency về 1 để ưu tiên tính ổn định.

## [1.2] - 2026-08-11

### Added

- Hàng cứu cuối cho `TECHNICAL_ERROR` lịch sử.
- Thống kê tok/s, giây/request, mục/phút và ETA.
- Diagnostic log chi tiết hơn.

### Historical note

- Thử nghiệm batch tối đa 20 và hai request song song đã được v1.3 thay thế bằng batch 10 chạy tuần tự.

## [1.1] - 2026-08-11

### Fixed

- Tắt Thinking của Qwen3.5 qua payload và template kwargs.
- Khi batch sai khuôn, tách và thử lại từng mục.
- Giữ checkpoint hợp lệ từ v1 và tái xử lý record lỗi rỗng.

## [1.0] - 2026-08-11

### Added

- Story Complete Worker đầu tiên cho corpus EN/JP.
- Checkpoint JSONL append-only và tiếp tục sau khi dừng.
- Kết nối LM Studio Local Server tại cổng 1234.
- Bảo vệ tên riêng/thuật ngữ và xuất Result ZIP.

