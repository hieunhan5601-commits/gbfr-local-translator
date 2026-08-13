# Định dạng đầu vào

Worker đọc ba file nằm cùng thư mục runtime:

- `config.json`
- `glossary.json`
- `data/story_job.json`

## `story_job.json`

Các trường top-level khuyến nghị:

| Trường | Kiểu | Ý nghĩa |
|---|---:|---|
| `jobId` | string | ID bất biến của lượt dịch |
| `createdAt` | string | ISO-8601 timestamp |
| `source` | string/object | Mô tả nguồn; không bắt buộc với runtime |
| `rules` | object | Metadata policy; không bắt buộc với runtime |
| `counts` | object | Số liệu kiểm kê; không bắt buộc với runtime |
| `items` | array | Danh sách mục Worker xử lý |

Mỗi item dùng schema:

| Trường | Kiểu | Bắt buộc | Ghi chú |
|---|---:|---:|---|
| `key` | string | Có | Duy nhất trong job; dùng làm JSON Schema key và checkpoint key |
| `file` | string | Có | Tên nguồn logic, không cần là đường dẫn thật |
| `row` | number | Có | Chỉ số ổn định trong file nguồn |
| `id` | string | Có | ID của entry; `TXT_CV_*` được giữ exact English |
| `subid` | string | Có | Sub-ID; dùng chuỗi rỗng nếu không có |
| `type` | string | Có | Loại bề mặt: scenario, note, description... |
| `english` | string | Có | Nguồn chính |
| `japanese` | string | Có | Nguồn phụ; dùng chuỗi rỗng nếu không có |
| `currentVietnamese` | string | Có | Bản đã có để kế thừa; chuỗi rỗng nếu chưa có |
| `inheritedR3` | boolean | Có | Chỉ `true` khi bản hiện có đã được khóa theo exact source |
| `sourceHash` | string | Có | SHA-256 để checkpoint không bám nhầm source đã đổi |

### Công thức `sourceHash`

Project hiện hành dùng:

```text
SHA256(file + U+001F + row + U+001F + English_NFC + U+001F + Japanese_NFC)
```

Chuẩn hóa CRLF/CR thành LF trước khi hash. Không ghép checkpoint theo vị trí gần đúng; chỉ dùng exact `key + sourceHash`.

## `glossary.json`

```json
{
  "keepExact": ["Captain", "Skyship"],
  "translateAs": {
    "Quest Counter": "Quầy nhiệm vụ",
    "Level": "Cấp độ"
  }
}
```

- `keepExact`: thuật ngữ phải xuất hiện đúng chính tả/hoa thường trong target nếu source có.
- `translateAs`: mapping thuật ngữ cần dịch nhất quán.

Tên nhân vật, địa danh, Weapon, item trong shop, Sigil, Trait và Skill đã khóa nên nằm trong policy phù hợp trước khi chạy.

## `config.json`

Dùng `config.example.json` làm điểm bắt đầu. Các trường quan trọng:

| Trường | Mặc định | Vai trò |
|---|---:|---|
| `endpoint` | `http://127.0.0.1:1234/v1` | OpenAI-compatible chat endpoint |
| `restEndpoint` | `http://127.0.0.1:1234/api/v1` | Quản lý model LM Studio |
| `modelPreference` | `qwen3.5`, `9b` | Chọn model theo tên |
| `contextLength` | `8192` | Context khi Worker load model |
| `evalBatchSize` | `512` | Eval batch; giảm 256 nếu CUDA lặp lại |
| `maxBatchItems` | `10` | Giới hạn mục mỗi batch |
| `parallelBatches` | `1` | Chạy tuần tự |
| `pilotItems` | `100` | Fresh pilot tối thiểu |
| `pilotMinPrimaryAcceptance` | `0.98` | Ngưỡng đạt sau repair |

Không tăng batch/concurrency khi chưa có benchmark và hồi quy riêng.

## Output status

| Status | Ý nghĩa |
|---|---|
| `INHERITED_R3` | Dữ liệu kế thừa theo exact source |
| `LOCAL_OK` | Đạt QA kỹ thuật, chưa duyệt ngôn ngữ |
| `REVIEW` | Đạt kỹ thuật nhưng có cảnh báo/hậu kiểm |
| `TECHNICAL_ERROR` | Không được merge; downstream giữ English source |

