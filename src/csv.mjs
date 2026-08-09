export function parseCsv(text) {
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV kết thúc khi một ô vẫn còn mở dấu ngoặc kép.");
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

export function csvToObjects(text) {
  const matrix = parseCsv(text);
  if (!matrix.length) return { headers: [], rows: [] };
  const headers = matrix[0].map((value, index) => String(value || `Column_${index + 1}`).trim());
  const rows = matrix.slice(1)
    .filter((cells) => cells.some((cell) => String(cell).length > 0))
    .map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
  return { headers, rows };
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function objectsToCsv(rows, headers, { bom = true } = {}) {
  const lines = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))]
    .map((cells) => cells.map(csvEscape).join(","));
  return `${bom ? "\uFEFF" : ""}${lines.join("\r\n")}\r\n`;
}
