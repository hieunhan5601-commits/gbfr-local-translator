# Xử lý lỗi

## Không tìm thấy Node.js

Cài Node.js 20+ và mở lại terminal. Kiểm tra:

```powershell
node --version
```

## Không tìm thấy model trong LM Studio

- Tải Qwen3.5-9B trong LM Studio.
- Bật **Developer > Local Server**.
- Xác nhận cổng `1234` hoặc sửa `endpoint`/`restEndpoint` trong config.
- Tên model phải chứa các phần trong `modelPreference`.

## `400 Bad Request: terminated` kèm CUDA illegal memory access

Đây thường là model/GPU bị chấm dứt, không phải checkpoint hỏng.

1. Đóng Worker.
2. Thoát hoàn toàn LM Studio, kể cả system tray.
3. Mở lại LM Studio và Local Server.
4. Chạy lại Worker; không xóa `progress`.
5. Nếu lặp lại, khởi động lại Windows và giảm `evalBatchSize` từ `512` xuống `256`.

## Worker dừng `EARLY_RECOVERY_GROWTH`

Giữ nguyên `progress` và kiểm tra các ID mới nhất trong failure log. Không tăng ngưỡng ngay; root cause có thể là CJK, protected term, metadata giữ English hoặc false positive QA.

## Worker dừng `UNRESOLVED_RATE_TOO_HIGH`

Rule này chỉ áp dụng khi vẫn còn fresh batch. Nếu xảy ra sau fresh batch cuối trên v1.8, mở bug report bằng dữ liệu tổng hợp vì đó là hồi quy.

## Worker dừng `STRUCTURED_OUTPUT_FAILURE`

Kiểm tra:

- LM Studio có trả JSON Schema đúng không;
- model có đúng Qwen3.5-9B không;
- Thinking đã được tắt;
- context/token budget có đủ không;
- response bị cắt do timeout/CUDA hay không.

## Có `TECHNICAL_ERROR` khi hoàn tất

Đây là trạng thái hợp lệ của một baseline có fallback. Không merge candidate trống/lỗi. Đưa exact key vào Hybrid QA hoặc sửa delta; downstream giữ English source.

## Dừng máy giữa chừng

Nhấn `Ctrl+C` một lần để dừng an toàn. Nếu máy tắt đột ngột, Worker bỏ qua dòng JSONL cuối bị dở và tiếp tục từ các record hợp lệ.

## Gửi log để nhờ hỗ trợ

Failure log có thể chứa source và response. Không đính kèm nguyên bản vào issue công khai. Hãy tạo fixture tổng hợp tối thiểu gồm:

- item schema;
- candidate giả lập;
- QA error;
- Worker/config version;
- phần stack trace không chứa dữ liệu game.

