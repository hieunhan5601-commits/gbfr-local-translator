# GBFR Local Translator — CodeMapped v0.2.0-beta.5-tech

Đây là **technical candidate**, tách khỏi Beta 4/Golden Master. Candidate không sửa `.msg`, không chạm `data.i` và không tự phát hành bản cài.

## Những điểm đã bổ sung

- Context Layer được truy xuất theo đúng `File + Row + ID + SubID` và đưa vào prompt production khi dòng đủ điều kiện.
- Dòng `LOCKED` hoặc nguồn chưa đạt bị chặn khỏi AI.
- Hai dòng giống English nhưng khác cảnh không còn bị gom chung một translation unit.
- Dataset contract khóa số dòng, thứ tự, `File/Row/ID/SubID`, English và Japanese.
- P0 release gate yêu cầu bằng chứng cài, boot, UI, combat, gỡ và rollback trước release candidate.
- CodeGraph được khai báo cục bộ để index phần source sạch; data/seed/MSG/ZIP không đi vào graph.

## Chạy kiểm tra

```bash
npm ci
npm test
```

## CodeGraph

```bash
npm run codegraph:init
npm run codegraph:status
```

`node_modules/` và `.codegraph/` là dữ liệu local, không commit lên GitHub. Repository chỉ lưu `package.json`, lockfile, `codegraph.json`, source, test và tài liệu codemap.

Hai corpus seed Beta 3/Beta 4 và Context Database production đầy đủ không được commit, kể cả hash và thống kê chi tiết phát sinh từ dữ liệu riêng. Test trên GitHub dùng fixture tổng hợp nhỏ trong `tests/fixtures/`; kiểm định toàn corpus và Context Layer thật chỉ chạy ở máy nội bộ có dữ liệu riêng.

Để nối MCP với Codex hoặc GitHub Copilot trên máy làm việc, chạy một lần theo tài liệu chính thức:

```bash
npx codegraph install
```

## Release gate

1. Sao chép `P0_EVIDENCE_TEMPLATE.json` thành file bằng chứng của candidate.
2. Điền đường dẫn ảnh/log thực tế và đổi từng trạng thái sang `PASS`.
3. Chạy:

```bash
npm run release:gate -- --report <production_report.json> --evidence <P0_EVIDENCE.json> --output <RELEASE_GATE_REPORT.json>
```

Gate không thay thế người kiểm thử. Nó chỉ ngăn candidate được xem là sẵn sàng khi chưa có bằng chứng.

## Tài liệu

- `docs/CODEMAP.md`: bản đồ kiến trúc và luồng gọi.
- `docs/CODEGRAPH_STATUS.md`: số liệu index CodeGraph đã xác minh.
- `docs/BAO_CAO_DOI_CHIEU_VA_KHAC_PHUC.md`: đối chiếu báo cáo và trạng thái khắc phục.
- `docs/GITHUB_CODEGRAPH_SETUP.md`: phạm vi repository và cách đưa candidate lên GitHub.
