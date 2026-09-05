export const MAX_TEXT_CHARS = 2_000;
export const MAX_NAME_CHARS = 120;
export const MAX_ID_CHARS = 120;
export const MAX_CSV_BYTES = 3 * 1024 * 1024;

export class CsvError extends Error {}

export type SourceRow = { id: string; name: string; text: string; upvotes: number; lens: string };

/**
 * 問題池 CSV：需要 id 與 comment（或 text／question）；interview（或 name／nickname）、upvotes、lens 可選。
 * 直接吃 Call-in、Pocket Polis、Pocket Form 匯出的 tttc.csv。
 */
export function parseQuestionsCsv(text: string, maxRows: number): SourceRow[] {
  if (typeof text !== "string") throw new CsvError("CSV 不是文字");
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length === 0) throw new CsvError("CSV 是空的");
  const headers = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase().replace(/-/g, "_"));
  const find = (...names: string[]) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const idIndex = find("id", "qid", "question_id", "comment_id");
  const textIndex = find("comment", "text", "question", "comment_body", "question_text");
  const nameIndex = find("interview", "name", "nickname", "participant");
  const upvotesIndex = find("upvotes", "votes", "agrees");
  const lensIndex = find("lens", "source_lens");
  if (idIndex < 0 || textIndex < 0) throw new CsvError("CSV 需要 id 與 comment 兩欄（interview、upvotes、lens 可選），例如 tttc.csv");
  const body = rows.slice(1);
  if (body.length === 0) throw new CsvError("CSV 沒有資料列");
  if (body.length > maxRows) throw new CsvError(`這個部署每個問題池最多 ${maxRows} 則提問，目前有 ${body.length} 則`);
  const seen = new Set<string>();
  const out: SourceRow[] = [];
  body.forEach((cells, index) => {
    const rowNumber = index + 2;
    const id = clean(cells[idIndex] ?? "", MAX_ID_CHARS);
    const question = cleanMultiline(cells[textIndex] ?? "", MAX_TEXT_CHARS);
    if (!id) throw new CsvError(`第 ${rowNumber} 列的 id 是空的`);
    if (seen.has(id)) throw new CsvError(`第 ${rowNumber} 列的 id 重複：${id}`);
    if (!question) throw new CsvError(`第 ${rowNumber} 列的 comment 是空的`);
    seen.add(id);
    const upvotes = upvotesIndex >= 0 ? Number(cells[upvotesIndex]) : 0;
    out.push({
      id,
      name: nameIndex >= 0 ? clean(cells[nameIndex] ?? "", MAX_NAME_CHARS) : "",
      text: question,
      upvotes: Number.isFinite(upvotes) && upvotes > 0 ? Math.floor(upvotes) : 0,
      lens: lensIndex >= 0 ? clean(cells[lensIndex] ?? "", 40) : "",
    });
  });
  return out;
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim().replace(/^[=+\-@]+/, "").slice(0, max);
}

function cleanMultiline(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().replace(/^[=+\-@]+/, "").slice(0, max);
}

export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvTable(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (quoted) {
      if (character === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote) {
      if (character === ",") {
        row.push(field);
        field = "";
        closedQuote = false;
      } else if (character === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        closedQuote = false;
      } else if (character !== "\r") {
        throw new CsvError(`CSV 第 ${rows.length + 1} 列的引號欄位後有無效字元`);
      }
    } else if (character === '"') {
      if (field !== "") throw new CsvError(`CSV 第 ${rows.length + 1} 列的未加引號欄位含有引號`);
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (quoted) throw new CsvError("CSV 有未關閉的引號");
  if (field !== "" || row.length > 0 || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell !== ""));
}
