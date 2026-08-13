# Support — Hỗ trợ sử dụng

Tài liệu này xác định phạm vi hỗ trợ công khai của **GBFR Local Translator** để issue có thể được tái hiện, xử lý và không làm lộ dữ liệu game hoặc dữ liệu cá nhân.

## Có thể mở issue cho

- Worker không khởi động hoặc báo lỗi runtime có thể tái hiện.
- Không kết nối được LM Studio Local Server dù endpoint/config đúng.
- Lỗi checkpoint, resume hoặc nguy cơ mất tiến độ.
- False positive/false negative của QA kỹ thuật: placeholder, printf token, số, protected term, CJK leak, English leak hoặc Structured Output.
- Hành vi khác nhau giữa các version Worker.
- Tài liệu cài đặt, input schema, release archive hoặc checksum không rõ/không khớp.
- Đề xuất cải tiến pipeline, test, QA hoặc quy trình phát hành.

## Không xử lý qua issue công khai

- Yêu cầu cung cấp game, file `.msg`, `data.i`, asset, font hoặc nội dung trích xuất có bản quyền.
- Upload corpus dịch thật, `story_job.json` thật, Context Database production, checkpoint hoặc log nguyên bản có chứa source/candidate.
- API key, token, mật khẩu, đường dẫn chứa thông tin cá nhân hoặc dữ liệu riêng khác.
- Yêu cầu xác nhận một bản dịch cốt truyện/lore là “đúng tuyệt đối” chỉ dựa trên model output.
- Phân phối model AI hoặc phần mềm bên thứ ba không thuộc repository này.
- Vấn đề liên quan đến bản sao game không hợp pháp.

## Trước khi báo lỗi

Hãy chuẩn bị tối thiểu:

- Worker version.
- Node.js version.
- LM Studio version.
- Model và quant đang dùng.
- GPU/VRAM và phiên bản Windows.
- Các bước tái hiện lỗi.
- Kết quả mong đợi và kết quả thực tế.
- Fixture tổng hợp nhỏ nhất vẫn tái hiện được lỗi.

Nếu lỗi xuất hiện giữa một lượt dịch dài, **không xóa `progress/`** chỉ để thử lại. Giữ checkpoint và tạo bản sao trước khi thay đổi runtime/config.

## Cách chia sẻ log an toàn

`story_request_log.jsonl`, `story_failed_responses.jsonl`, checkpoint và report có thể chứa source hoặc candidate đầy đủ. Không đăng nguyên file lên issue công khai.

Thay vào đó:

1. Tạo một item giả lập có cùng cấu trúc gây lỗi.
2. Thay English/Japanese/Vietnamese bằng nội dung tổng hợp.
3. Xóa đường dẫn máy cá nhân và metadata không liên quan.
4. Chỉ giữ error code, stack trace và trường cấu hình cần thiết để tái hiện.

Xem thêm [SECURITY.md](SECURITY.md) và [CONTRIBUTING.md](CONTRIBUTING.md).

## Mức hỗ trợ

Đây là dự án fan-made và được duy trì theo khả năng của maintainer. Bug có nguy cơ làm hỏng checkpoint, ghi dữ liệu sai vị trí, thực thi ngoài ý muốn hoặc kết nối mạng ngoài endpoint cấu hình sẽ được ưu tiên cao hơn lỗi wording/semantic đơn lẻ.

Một issue đầy đủ dữ liệu tái hiện bằng fixture tổng hợp sẽ có khả năng được xử lý nhanh hơn issue chỉ có ảnh chụp hoặc mô tả chung.
