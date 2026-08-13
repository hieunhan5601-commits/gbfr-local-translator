# Security và quyền riêng tư

Worker chỉ gọi endpoint cục bộ được cấu hình trong `config.json`; mặc định là `127.0.0.1:1234`. Repository không cần API key và không thu thập telemetry.

## Dữ liệu nhạy cảm trong log

Hai file dưới đây có thể chứa source hoặc candidate đầy đủ:

- `progress/story_request_log.jsonl`
- `progress/story_failed_responses.jsonl`

Không đăng chúng nguyên bản lên issue công khai. Hãy tạo một ví dụ tổng hợp hoặc xóa nội dung source/response trước khi chia sẻ.

## Báo cáo lỗ hổng

Không công khai exploit, dữ liệu game hoặc thông tin cá nhân trong issue. Hãy mở một issue chỉ mô tả phạm vi ở mức cao và đề nghị maintainer chuyển sang kênh riêng trước khi gửi chi tiết nhạy cảm.

## Phạm vi hỗ trợ

- Lỗi ghi đè/mất checkpoint.
- Ghi log ngoài thư mục dự kiến.
- Thực thi lệnh ngoài ý muốn.
- Kết nối mạng ngoài endpoint đã cấu hình.
- Dependency hoặc archive phát hành bị thay đổi checksum.

Model output sai nghĩa không phải lỗ hổng bảo mật; hãy báo bằng bug report và cung cấp ví dụ tổng hợp.

