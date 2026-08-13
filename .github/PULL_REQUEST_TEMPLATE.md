## Tóm tắt

Mô tả ngắn thay đổi và vấn đề mà pull request này giải quyết.

## Nguyên nhân / động cơ

- Root cause hoặc nhu cầu:
- Hành vi trước thay đổi:
- Hành vi sau thay đổi:

## Phạm vi

Liệt kê module, Worker version, input/output contract hoặc tài liệu bị ảnh hưởng.

## Kiểm thử

Ghi rõ các lệnh/test đã chạy và kết quả.

```text
npm test
```

Nếu thay đổi runtime, bổ sung fixture tổng hợp tái hiện lỗi hoặc regression test tương ứng.

## Checkpoint và compatibility

- Checkpoint cũ có tiếp tục dùng được không?
- `key` / `sourceHash` / input schema có thay đổi không?
- Có migration hoặc rollback step nào cần ghi rõ không?

## Release impact

- [ ] Không ảnh hưởng runtime/release.
- [ ] Có thay đổi hành vi runtime và đã cập nhật `CHANGELOG.md`.
- [ ] Có thay đổi release archive/checksum và đã cập nhật tài liệu phát hành.

## Data & privacy checklist

- [ ] Không chứa file `.msg`, `data.i`, asset, font hoặc dữ liệu trích xuất từ game.
- [ ] Không chứa corpus thật, `story_job.json` thật, Context Database production, checkpoint hoặc log nguyên bản.
- [ ] Không chứa API key, token, mật khẩu hoặc thông tin cá nhân.
- [ ] Fixture/test mới chỉ dùng dữ liệu tổng hợp.
- [ ] Raw source/identity bất biến; thay đổi chỉ tác động vào vùng output được phép.

## QA checklist

- [ ] `npm test` PASS.
- [ ] Không nới QA toàn corpus chỉ để chữa một false positive cục bộ.
- [ ] `LOCAL_OK`/`REVIEW` không bị tự động nâng thành `APPROVED`.
- [ ] Có mô tả rollback cho thay đổi có rủi ro checkpoint hoặc release.
- [ ] Tài liệu đã được cập nhật nếu hành vi người dùng nhìn thấy thay đổi.

## Ghi chú cho reviewer

Nêu phần cần reviewer tập trung: parser, QA rule, checkpoint semantics, privacy boundary, compatibility, release gate hoặc wording.
