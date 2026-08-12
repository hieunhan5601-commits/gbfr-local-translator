# Kiến trúc Story Complete Worker v1.8

## Nguyên tắc

Worker xem model là bộ tạo candidate. Script, exact source hash và trạng thái duyệt quyết định dữ liệu nào được phép đi tiếp.

## Trình tự

1. Đọc job, config và glossary.
2. Đọc checkpoint JSONL; bỏ record sai key/source hash hoặc không còn qua QA hiện hành.
3. Đọc failure log để tách backlog lịch sử khỏi fresh pilot.
4. Ghi deterministic metadata `TXT_CV_*` về exact English.
5. Kế thừa `INHERITED_R3` đã được job đánh dấu.
6. Load một model Qwen phù hợp trong LM Studio; unload instance khác.
7. Dịch fresh queue theo batch tối đa 10 bằng Structured Output JSON Schema.
8. QA từng candidate; câu lỗi được sửa riêng ngay tối đa hai lượt.
9. Chỉ khi pilot đạt gate mới chạy phần fresh queue còn lại.
10. Đưa backlog và mục chưa cứu vào hàng cứu nhóm, sau đó cứu lẻ.
11. Ghi report và ZIP kết quả.

## QA kỹ thuật

Worker kiểm tra:

- chuỗi rỗng;
- chữ Hán, kana hoặc hangul lọt vào target;
- marker nội bộ chưa phục hồi;
- meta text của model;
- placeholder/printf/private-use token;
- con số;
- protected terms;
- English giữ nguyên ngoài trường hợp được phép;
- dấu hiệu English leak, mất line break và tỷ lệ độ dài bất thường.

## Cổng dừng

- Structured Output lỗi còn tồn sau repair vượt ngưỡng.
- Một batch thất bại toàn bộ sau repair.
- Hàng unresolved tăng sớm khi vẫn còn fresh batch.
- Pilot đạt sau repair thấp hơn ngưỡng cấu hình.

Sau fresh batch cuối, unresolved được phép đi vào hàng cứu thay vì dừng bởi cổng tỷ lệ. Đây là thay đổi chính của v1.8.

## Checkpoint

Checkpoint là JSONL append-only. Khi có nhiều record cùng key, record hợp lệ mới nhất theo exact `sourceHash` được dùng. Dòng JSON cuối bị ghi dở sau forced shutdown được bỏ qua; các dòng hợp lệ trước đó vẫn giữ nguyên.

## Ranh giới

Worker không:

- trích xuất hoặc đóng gói MSG;
- quyết định bản dịch được `APPROVED`;
- inject vào game;
- sửa font;
- thay thế Hybrid QA, language QA hoặc playtest.

