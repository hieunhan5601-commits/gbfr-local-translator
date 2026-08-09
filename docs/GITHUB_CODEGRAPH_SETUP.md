# GitHub + CodeGraph setup

## Repository đề xuất

- Tên: `gbfr-local-translator`
- Visibility: **Private**
- Nhánh mặc định: `main` chỉ chứa Golden Master đã xác nhận.
- Nhánh candidate: `technical/context-contract-p0`.
- Không đưa `.msg`, `data.i`, ZIP bản game hoặc corpus dịch đầy đủ lên repo.

## Nội dung commit

- `src/`, `tests/`, `config/`.
- `package.json`, `package-lock.json`.
- `codegraph.json`, `.gitignore`.
- `docs/` và template P0.
- `tests/fixtures/context-layer-synthetic.json`: Context Layer fixture tổng hợp dùng cho exact-line test.
- `tests/fixtures/seed-policy.json`: fixture tổng hợp tối thiểu, không chứa corpus dịch.

Hai file seed production và Context Database thật phải ở ngoài GitHub. Hash và thống kê chi tiết của dữ liệu riêng cũng không công bố; các kiểm định toàn corpus/Context thật chỉ chạy trên máy nội bộ.

## Khởi tạo trên máy làm việc

```bash
npm ci
npm run codegraph:init
npm run codegraph:status
npx codegraph install
```

CodeGraph tạo SQLite local ở `.codegraph/`. Thư mục này không commit; mỗi máy tự index checkout của mình. GitHub lưu source và cấu hình, không lưu knowledge graph phụ thuộc hệ điều hành.

## Cổng merge

1. `npm test` PASS.
2. CodeGraph status sạch, không index artifact ngoài scope.
3. Diff chỉ thuộc một nhóm thay đổi kỹ thuật.
4. Dataset contract PASS trên candidate thật.
5. Human review approved.
6. P0 evidence gate PASS.
7. Người dùng xác nhận trong game rồi mới merge vào `main`.
