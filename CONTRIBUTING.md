# Đóng góp

Cảm ơn bạn muốn cải thiện GBFR Local Translator. Ưu tiên cao nhất của dự án là an toàn dữ liệu, khả năng tiếp tục checkpoint và bằng chứng QA có thể lặp lại.

## Trước khi mở issue hoặc pull request

- Không tải lên MSG, file game, `story_job.json` thật, glossary nội bộ, checkpoint hoặc log chứa source.
- Dùng dữ liệu tổng hợp tối thiểu để tái hiện lỗi.
- Nếu cần trích log, xóa toàn bộ English/Japanese/Vietnamese source và thông tin đường dẫn cá nhân.
- Ghi rõ Worker version, Node.js version, LM Studio, model/quant, GPU/VRAM và thao tác gây lỗi.

## Nguyên tắc thay đổi Worker

1. Không sửa raw input.
2. Không làm mất checkpoint hợp lệ.
3. Không nới một QA rule trên toàn corpus để chữa một false positive cục bộ.
4. Mọi thay đổi checkpoint semantics phải có exact key/source-hash test.
5. Không auto-promote `LOCAL_OK` hoặc `REVIEW` thành `APPROVED`.
6. Một hotfix phải có version mới và mục tương ứng trong `CHANGELOG.md`.

## Kiểm thử

```bash
npm test
```

Pull request nên mô tả:

- vấn đề và root cause;
- hành vi trước/sau;
- phạm vi dữ liệu bị ảnh hưởng;
- test mới hoặc test hồi quy;
- rủi ro checkpoint và cách rollback.

## Commit và version

- Commit ngắn, mô tả đúng một phạm vi thay đổi.
- Dùng version mới cho thay đổi hành vi runtime.
- Bản release phải có ZIP, SHA-256 và tài liệu giới hạn đã biết.

