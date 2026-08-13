# Quy trình phát hành

Mục tiêu là để mỗi bản cập nhật có thể kiểm chứng, rollback và không làm trôi checkpoint.

## Checklist

1. Tạo version mới; không ghi đè bản phát hành cũ.
2. Ghi root cause, thay đổi hành vi và phạm vi trong `CHANGELOG.md`.
3. Thêm test hồi quy cho lỗi vừa sửa bằng dữ liệu tổng hợp.
4. Chạy syntax check và toàn bộ test tuần tự.
5. Kiểm tra archive không chứa dữ liệu game, `progress`, log, result hoặc secret.
6. Giải nén archive sang thư mục mới và đối chiếu byte với build tree.
7. Ghi SHA-256 vào `releases/SHA256SUMS.txt`.
8. Nêu rõ trạng thái: baseline tool, hotfix, candidate hay release.
9. Nêu giới hạn và bước tiếp theo; không dùng phần trăm không có mẫu số.
10. Cập nhật tài liệu troubleshooting nếu có failure mode mới.

## Versioning

- Patch/hotfix: sửa parser, QA rule hoặc lỗi vận hành có phạm vi hẹp.
- Minor: thay đổi pipeline/format nhưng có migration checkpoint rõ ràng.
- Major: thay đổi contract đầu vào, checkpoint hoặc output không tương thích.

Tên Worker lịch sử dùng `v1.0` đến `v1.8`. Repository biểu diễn bản hiện tại dưới version package `1.8.0` nhưng giữ nguyên tên file phát hành để người dùng đối chiếu.

## Gate trước nhãn final

Một bản Việt hóa không được gọi `final`, `RC1` hoặc `v1.0` chỉ vì Worker hoàn tất. Cần tối thiểu:

- kiểm toán `source = translated + fallback + blocked`;
- Hybrid/language QA;
- MSG round-trip;
- package manifest và rollback;
- kiểm tra font;
- playtest các bề mặt P0 trong game.

