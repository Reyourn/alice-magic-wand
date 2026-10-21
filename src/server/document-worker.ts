import { fileURLToPath } from 'node:url';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARACTERS, type ExtractedDocument } from './documents.js';
import { validateOfficeZip } from './document-zip.js';
import { extractPptx } from './pptx.js';

const MAX_PDF_PAGES = 100, MAX_SHEETS = 20, MAX_ROWS = 5000, MAX_COLUMNS = 100;

class TextOutput {
  text = '';
  truncated = false;
  add(value: string): boolean {
    const available = MAX_DOCUMENT_CHARACTERS - this.text.length;
    if (value.length > available) {
      let part = value.slice(0, available);
      if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1);
      this.text += part; this.truncated = true; return false;
    }
    this.text += value; return true;
  }
}
function output(text: TextOutput, format: string, detail: string): ExtractedDocument {
  return { text: text.text, truncated: text.truncated, format, detail: `${detail}${text.truncated ? '；内容已截断（最多 40,000 字符）' : ''}` };
}
function plainText(bytes: Buffer, extension: string): ExtractedDocument {
  let value: string, encoding = 'UTF-8';
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'UTF-16LE'; value = new TextDecoder('utf-16le', { fatal: true }).decode(bytes); }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'UTF-16BE'; value = new TextDecoder('utf-16be', { fatal: true }).decode(bytes); }
    else {
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch {
        if (!['.csv', '.tsv'].includes(extension)) throw new Error();
        encoding = 'GB18030'; value = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
      }
    }
  } catch { throw new Error('文本编码无法识别，请另存为 UTF-8 或带 BOM 的 UTF-16；CSV 也支持 GB18030。'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(value)) throw new Error('文件包含二进制内容，无法作为文本读取。');
  if (!value.trim()) throw new Error('文件没有可读取的文字。');
  const result = new TextOutput(); result.add(value);
  return output(result, 'TEXT', `按 ${encoding} 读取纯文本`);
}
async function pdf(bytes: Buffer): Promise<ExtractedDocument> {
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效的 PDF。');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, enableXfa: false, useWorkerFetch: false, useWasm: false, verbosity: 0 });
  let document: Awaited<typeof task.promise> | undefined;
  try {
    document = await task.promise;
    const result = new TextOutput(); let hasText = false, readPages = 0;
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, MAX_PDF_PAGES); pageNumber++) {
      const page = await document.getPage(pageNumber), content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
      page.cleanup(); readPages++;
      if (text) { hasText = true; if (!result.add(`[第 ${pageNumber} 页]\n${text}\n\n`)) break; }
    }
    if (!hasText) throw new Error('PDF 没有可提取的文字，可能是扫描件；目前暂不支持 OCR。');
    if (readPages < document.numPages) result.truncated = true;
    return output(result, 'PDF', `读取 ${readPages}/${document.numPages} 页（最多 ${MAX_PDF_PAGES} 页）`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('暂不支持 OCR')) throw error;
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('PDF 已加密，请先保存为未加密文件。');
    throw new Error('PDF 无法解析，文件可能已损坏或格式不受支持。');
  } finally { await task.destroy().catch(() => {}); }
}
async function docx(bytes: Buffer): Promise<ExtractedDocument> {
  validateOfficeZip(bytes, 'word/document.xml');
  try {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    if (!value.trim()) throw new Error('empty');
    const result = new TextOutput(); result.add(value);
    return output(result, 'DOCX', '提取文档纯文本，不读取嵌入图片');
  } catch (error) { throw new Error(error instanceof Error && error.message === 'empty' ? '文档没有可提取的文字；嵌入图片暂不支持 OCR。' : 'Word 文档无法解析，文件可能已损坏或加密。'); }
}
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  const item = value as Record<string, unknown>;
  if ('formula' in item || 'sharedFormula' in item) return `[公式 ${String(item.formula ?? item.sharedFormula)}；${item.result === undefined ? '无缓存结果，未计算' : `缓存值：${cellText(item.result)}`}]`;
  if (Array.isArray(item.richText)) return item.richText.map(part => typeof part?.text === 'string' ? part.text : '').join('');
  if (typeof item.text === 'string') return item.text;
  if (typeof item.error === 'string') return item.error;
  return '';
}
async function xlsx(bytes: Buffer): Promise<ExtractedDocument> {
  validateOfficeZip(bytes, 'xl/workbook.xml');
  try {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const result = new TextOutput(); let hasText = false, sheetsRead = 0;
    for (const sheet of workbook.worksheets.slice(0, MAX_SHEETS)) {
      sheetsRead++;
      if (!result.add(`[工作表：${sheet.name}]\n`)) break;
      const rows = Math.min(sheet.rowCount, MAX_ROWS), columns = Math.min(sheet.columnCount, MAX_COLUMNS);
      if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) result.truncated = true;
      let full = false;
      for (let row = 1; row <= rows; row++) {
        const values: string[] = [];
        for (let column = 1; column <= columns; column++) {
          const cell = sheet.getRow(row).getCell(column), value = cellText(cell.value);
          if (value.trim()) { hasText = true; values.push(`${cell.address}: ${value}`); }
        }
        if (values.length && !result.add(`${values.join(' | ')}\n`)) { full = true; break; }
      }
      if (full || !result.add('\n')) break;
    }
    if (!hasText) throw new Error('empty');
    if (sheetsRead < workbook.worksheets.length) result.truncated = true;
    return output(result, 'XLSX', `读取 ${sheetsRead}/${workbook.worksheets.length} 张表（最多 ${MAX_SHEETS} 张表，每表 ${MAX_ROWS} 行、${MAX_COLUMNS} 列）；公式只读取缓存结果，未重新计算`);
  } catch (error) { throw new Error(error instanceof Error && error.message === 'empty' ? '表格没有可读取的单元格内容。' : 'Excel 文档无法解析，文件可能已损坏或加密。'); }
}
export async function extractInWorker(bytes: Buffer, extension: string): Promise<ExtractedDocument> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new Error('文件为空或超过 20 MiB 限制。');
  switch (extension.toLowerCase()) {
    case '.pdf': return pdf(bytes);
    case '.docx': return docx(bytes);
    case '.xlsx': return xlsx(bytes);
    case '.pptx': return extractPptx(bytes);
    default: return plainText(bytes, extension);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  // Keep stdout a single bounded JSON frame; third-party parsers may log warnings.
  console.log = console.warn = console.info = () => {};
  let input = '', inputBytes = 0;
  process.stdin.on('data', (chunk: Buffer) => {
    inputBytes += chunk.length;
    if (inputBytes > MAX_DOCUMENT_BYTES * 1.4 + 1024) process.exit(1);
    input += chunk.toString('utf8');
  });
  process.stdin.on('end', async () => {
    try {
      const request = JSON.parse(input) as { data: string; extension: string };
      if (typeof request.data !== 'string' || typeof request.extension !== 'string' || request.extension.length > 32) throw new Error('文件解析请求无效。');
      const result = await extractInWorker(Buffer.from(request.data, 'base64'), request.extension);
      process.stdout.write(JSON.stringify(result));
    } catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : '文件解析失败。' })); }
  });
}
