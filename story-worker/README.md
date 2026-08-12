# Story Complete Worker v1.8

Thư mục này chứa mã nguồn có thể chạy của Worker. Nó không chứa corpus hoặc glossary dự án.

## Chuẩn bị

```text
story-worker/
├── 01_CHAY_DICH_STORY_COMPLETE.cmd
├── worker.mjs
├── config.json
├── glossary.json
├── data/
│   └── story_job.json
└── progress/                 # Worker tự tạo
```

1. Đổi `config.example.json` thành `config.json`.
2. Sao chép `glossary.example.json` thành `glossary.json`, sau đó bổ sung protected terms thật.
3. Tạo `data/story_job.json` theo file mẫu.
4. Bật LM Studio Local Server.
5. Chạy file CMD.

Không dùng `glossary.example.json` cho corpus thật nếu chưa điền đầy đủ tên/thuật ngữ phải giữ nguyên.

## Cập nhật chồng từ v1.7 hoặc cũ hơn

ZIP trong `releases/` chỉ thay runtime/config/docs. Khi giải nén chồng:

- giữ nguyên `data/`;
- giữ nguyên `progress/`;
- giữ nguyên `glossary.json`;
- xác nhận dòng đầu hiển thị Worker `v1.8`.

## Dừng an toàn

Nhấn `Ctrl+C` một lần. Worker hoàn tất request đang chạy rồi dừng. Chạy lại file CMD để tiếp tục từ checkpoint. Chỉ nhấn lần hai khi buộc phải thoát ngay.

