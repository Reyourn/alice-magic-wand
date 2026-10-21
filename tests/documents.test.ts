import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { DOCUMENT_TIMEOUT_MS, extractDocument, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARACTERS } from '../src/server/documents.js';
import { validateOfficeZip } from '../src/server/document-zip.js';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => { vi.useRealTimers(); vi.mocked(spawn).mockClear(); });

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string>, options: { declaredSize?: number; encrypted?: boolean } = {}): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), packed = deflateRawSync(bytes), crc = crc32(bytes), size = options.declaredSize ?? bytes.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(options.encrypted ? 1 : 0, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, packed);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(options.encrypted ? 1 : 0, 8); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function docx(text: string): Buffer {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
}
function pdf(text = 'Synthetic document 8642'): Buffer {
  const stream = text ? `BT /F1 16 Tf 20 100 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let result = '%PDF-1.4\n'; const positions = [0];
  for (let index = 0; index < objects.length; index++) { positions.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${positions.length}\n0000000000 65535 f \n${positions.slice(1).map(pos => `${String(pos).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${positions.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relationNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function presentationFiles(count = 2): Record<string, string> {
  const relation = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${relationNs}/${type}" Target="${target}"/>`;
  const relations = (values: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${values}</Relationships>`;
  const paragraph = (text: string) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
  const content = (text: string) => `<p:sp><p:txBody>${text}</p:txBody></p:sp>`;
  const slide = (text: string) => `<p:sld xmlns:p="${presentationNs}" xmlns:a="${drawingNs}"><p:cSld><p:spTree>${content(text)}</p:spTree></p:cSld></p:sld>`;
  const numbers = Array.from({ length: count }, (_, i) => i + 1).reverse();
  const files: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${numbers.map(i => `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="${presentationNs}" xmlns:r="${relationNs}"><p:sldIdLst>${numbers.map(i => `<p:sldId id="${255 + i}" r:id="rId${i}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relations(numbers.map(i => relation(`rId${i}`, 'slide', `slides/slide${i}.xml`)).join('')),
    'ppt/slides/_rels/slide1.xml.rels': relations(relation('notes', 'notesSlide', '../notesSlides/notesSlide1.xml')),
    'ppt/notesSlides/notesSlide1.xml': `<p:notes xmlns:p="${presentationNs}" xmlns:a="${drawingNs}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody>${paragraph('IGNORE-NUMBER')}</p:txBody></p:sp>${content(paragraph('演讲者备注 NOTE-4716'))}</p:spTree></p:cSld></p:notes>`,
  };
  for (const i of numbers) files[`ppt/slides/slide${i}.xml`] = slide(paragraph(`幻灯片文件 ${i}`));
  if (count > 1) files['ppt/slides/slide2.xml'] = slide('<a:p><a:r><a:t>客户&amp;运营</a:t></a:r><a:r><a:t>报告</a:t></a:r><a:br/><a:fld id="field"><a:t>2022年12月</a:t></a:fld></a:p><a:tbl><a:tr><a:tc><a:txBody>' + paragraph('客户总数') + '</a:txBody></a:tc><a:tc><a:txBody>' + paragraph('2689') + '</a:txBody></a:tc></a:tr></a:tbl>');
  return files;
}

describe('bounded document extraction', () => {
  it('extracts Chinese UTF-8, UTF-16 BOM and legacy Chinese CSV', async () => {
    const utf8 = await extractDocument({ name: '需求.md', bytes: Buffer.from('# 中文需求\n验收编号 8642') });
    expect(utf8).toMatchObject({ text: '# 中文需求\n验收编号 8642', format: 'TEXT', truncated: false });
    const utf16 = await extractDocument({ name: 'notes.txt', bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文说明', 'utf16le')]) });
    expect(utf16.text).toBe('中文说明');
    const csv = await extractDocument({ name: 'legacy.csv', bytes: Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x38, 0x36, 0x34, 0x32]) });
    expect(csv.text).toBe('中文,8642'); expect(csv.detail).toContain('GB18030');
  });
  it('rejects empty, binary, malformed text and excessive input', async () => {
    await expect(extractDocument({ name: 'empty.txt', bytes: Buffer.alloc(0) })).rejects.toThrow('为空');
    await expect(extractDocument({ name: 'large.txt', bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) })).rejects.toThrow('20 MiB');
    await expect(extractDocument({ name: 'binary.txt', bytes: Buffer.from('hello\0world') })).rejects.toThrow('二进制');
    await expect(extractDocument({ name: 'bad.txt', bytes: Buffer.from([0xff, 0xab, 0xcd]) })).rejects.toThrow('编码');
  });
  it('caps text length and reports truncation without a broken surrogate', async () => {
    const result = await extractDocument({ name: 'long.txt', bytes: Buffer.from('a'.repeat(MAX_DOCUMENT_CHARACTERS - 1) + '😀end') });
    expect(result.text.length).toBe(MAX_DOCUMENT_CHARACTERS - 1); expect(result.truncated).toBe(true); expect(result.detail).toContain('截断');
  });
  it('extracts actual PDF text with page provenance and rejects scan-only and damaged PDFs', async () => {
    const result = await extractDocument({ name: 'sample.pdf', bytes: pdf() });
    expect(result.text).toContain('[第 1 页]'); expect(result.text).toContain('Synthetic document 8642');
    await expect(extractDocument({ name: 'scan.pdf', bytes: pdf('') })).rejects.toThrow('暂不支持 OCR');
    await expect(extractDocument({ name: 'bad.pdf', bytes: Buffer.from('%PDF-1.4\nbroken') })).rejects.toThrow('无法解析');
  }, 20000);
  it('extracts actual DOCX text without rendering HTML or loading images', async () => {
    const result = await extractDocument({ name: 'sample.docx', bytes: docx('中文文档 8642') });
    expect(result.text).toContain('中文文档 8642'); expect(result.format).toBe('DOCX');
    await expect(extractDocument({ name: 'empty.docx', bytes: docx('') })).rejects.toThrow('没有可提取');
  });
  it('extracts XLSX cell addresses, sheet names and cached formulas without evaluating formulas', async () => {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('验收');
    sheet.getCell('A1').value = '中文表格'; sheet.getCell('B1').value = 8642;
    sheet.getCell('A2').value = { formula: '1+2', result: 3 };
    sheet.getCell('B2').value = { formula: 'WEBSERVICE("https://invalid.example")' };
    const result = await extractDocument({ name: 'sample.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()) });
    expect(result.text).toContain('[工作表：验收]'); expect(result.text).toContain('B1: 8642'); expect(result.text).toContain('缓存值：3'); expect(result.text).toContain('无缓存结果，未计算'); expect(result.detail).toContain('未重新计算');
  });
  it('extracts PPTX in presentation relationship order with runs, fields, breaks, tables and notes', async () => {
    const result = await extractDocument({ name: '客户运营报告.pptx', bytes: zip(presentationFiles()) });
    expect(result.format).toBe('PPTX'); expect(result.truncated).toBe(false);
    expect(result.text).toContain('[第 1 张幻灯片]\n客户&运营报告\n2022年12月\n');
    expect(result.text).toContain('[表格 1 第 1 行]\n[单元格 1] 客户总数\n[单元格 2] 2689');
    expect(result.text.indexOf('客户&运营')).toBeLessThan(result.text.indexOf('[第 2 张幻灯片]'));
    expect(result.text).toContain('[第 2 张备注]\n演讲者备注 NOTE-4716'); expect(result.text).not.toContain('IGNORE-NUMBER');
    expect(result.detail).toContain('2/2'); expect(result.detail).toContain('不读取图片、图表内容或视觉排版');
  });
  it('accepts Strict OOXML namespaces and alternate XML prefixes', async () => {
    const files = presentationFiles();
    for (const [name, text] of Object.entries(files)) files[name] = text.replaceAll(presentationNs, 'http://purl.oclc.org/ooxml/presentationml/main').replaceAll(drawingNs, 'http://purl.oclc.org/ooxml/drawingml/main').replaceAll(relationNs, 'http://purl.oclc.org/ooxml/officeDocument/relationships').replaceAll('xmlns:p=', 'xmlns:slide=').replaceAll('<p:', '<slide:').replaceAll('</p:', '</slide:').replaceAll('xmlns:a=', 'xmlns:draw=').replaceAll('<a:', '<draw:').replaceAll('</a:', '</draw:').replaceAll('xmlns:r=', 'xmlns:rel=').replaceAll(' r:id=', ' rel:id=');
    const result = await extractDocument({ name: 'strict.pptx', bytes: zip(files) });
    expect(result.text).toContain('客户&运营报告'); expect(result.text).toContain('NOTE-4716');
  });
  it('rejects referenced missing or malformed PPTX slides and notes rather than silently skipping them', async () => {
    const missingSlide = presentationFiles(); delete missingSlide['ppt/slides/slide2.xml'];
    await expect(extractDocument({ name: 'missing.pptx', bytes: zip(missingSlide) })).rejects.toThrow('缺少部件 ppt/slides/slide2.xml');
    const brokenSlide = presentationFiles(); brokenSlide['ppt/slides/slide2.xml'] = `<p:sld xmlns:p="${presentationNs}"><p:broken></p:sld>`;
    await expect(extractDocument({ name: 'broken.pptx', bytes: zip(brokenSlide) })).rejects.toThrow('XML 部件损坏');
    const missingNotes = presentationFiles(); delete missingNotes['ppt/notesSlides/notesSlide1.xml'];
    await expect(extractDocument({ name: 'missing-notes.pptx', bytes: zip(missingNotes) })).rejects.toThrow('缺少部件 ppt/notesSlides/notesSlide1.xml');
  });
  it('rejects unsupported PPTX package metadata, DTD, external and escaping slide relationships', async () => {
    const wrongType = presentationFiles(); wrongType['[Content_Types].xml'] = wrongType['[Content_Types].xml'].replace('presentation.main+xml', 'macroEnabled.main+xml');
    await expect(extractDocument({ name: 'renamed.pptx', bytes: zip(wrongType) })).rejects.toThrow('内容类型不符');
    const dtd = presentationFiles(); dtd['ppt/slides/slide2.xml'] = '<!DOCTYPE slide [<!ENTITY x SYSTEM "https://invalid.example/entity">]>' + dtd['ppt/slides/slide2.xml'];
    await expect(extractDocument({ name: 'entity.pptx', bytes: zip(dtd) })).rejects.toThrow('DTD');
    const external = presentationFiles(); external['ppt/_rels/presentation.xml.rels'] = external['ppt/_rels/presentation.xml.rels'].replace('Target="slides/slide2.xml"', 'TargetMode="External" Target="https://invalid.example/slide.xml"');
    await expect(extractDocument({ name: 'external.pptx', bytes: zip(external) })).rejects.toThrow('外部内容');
    const traversal = presentationFiles(); traversal['ppt/_rels/presentation.xml.rels'] = traversal['ppt/_rels/presentation.xml.rels'].replace('Target="slides/slide2.xml"', 'Target="../../outside.xml"');
    await expect(extractDocument({ name: 'traversal.pptx', bytes: zip(traversal) })).rejects.toThrow('超出文档范围');
  });
  it('reports image-only PPTX as no readable text and applies the existing ZIP limits', async () => {
    const files = presentationFiles(1);
    files['ppt/slides/slide1.xml'] = `<p:sld xmlns:p="${presentationNs}"><p:cSld><p:spTree><p:pic/></p:spTree></p:cSld></p:sld>`;
    delete files['ppt/slides/_rels/slide1.xml.rels'];
    await expect(extractDocument({ name: 'image-only.pptx', bytes: zip(files) })).rejects.toThrow('OCR');
    await expect(extractDocument({ name: 'encrypted.pptx', bytes: zip(files, { encrypted: true }) })).rejects.toThrow('加密');
    await expect(extractDocument({ name: 'damaged.pptx', bytes: Buffer.from('PK invalid') })).rejects.toThrow('压缩结构');
  });
  it('bounds PPTX extraction to 100 slides and 40,000 characters with explicit truncation', async () => {
    const manySlides = await extractDocument({ name: 'long-deck.pptx', bytes: zip(presentationFiles(101)) });
    expect(manySlides.truncated).toBe(true); expect(manySlides.detail).toContain('100/101');
    expect(manySlides.text).toContain('[第 100 张幻灯片]'); expect(manySlides.text).not.toContain('[第 101 张幻灯片]');
    const longText = presentationFiles(1);
    longText['ppt/slides/slide1.xml'] = longText['ppt/slides/slide1.xml'].replace('幻灯片文件 1', '很长的中文报告'.repeat(10000));
    const result = await extractDocument({ name: 'long-text.pptx', bytes: zip(longText) });
    expect(result.truncated).toBe(true); expect(result.text.length).toBe(MAX_DOCUMENT_CHARACTERS); expect(result.detail).toContain('40,000');
  });
  it('rejects corrupt Office files and encrypted archives before parsing', async () => {
    await expect(extractDocument({ name: 'broken.docx', bytes: Buffer.from('not zip') })).rejects.toThrow('压缩结构');
    await expect(extractDocument({ name: 'encrypted.docx', bytes: zip({ 'word/document.xml': 'x' }, { encrypted: true }) })).rejects.toThrow('加密');
  });
  it('bounds Office expansion and entry count, including a false declared expansion size', () => {
    expect(() => validateOfficeZip(zip({ 'word/document.xml': 'x' }, { declaredSize: 50 * 1024 * 1024 + 1 }), 'word/document.xml')).toThrow('50 MiB');
    expect(() => validateOfficeZip(zip({ 'word/document.xml': 'a'.repeat(10000) }, { declaredSize: 1 }), 'word/document.xml')).toThrow('展开大小');
    const entries = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`entry${i}`, '']));
    expect(() => validateOfficeZip(zip(entries), 'word/document.xml')).toThrow('2000');
  });
  it('limits concurrent parsers and kills timed-out workers before settling', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const first = extractDocument({ name: 'test.txt', bytes: Buffer.from('text') });
    const check = expect(first).rejects.toThrow('15 秒'); let settled = false;
    void first.then(() => { settled = true; }, () => { settled = true; });
    const secondChild = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValueOnce(secondChild as unknown as ReturnType<typeof spawn>);
    const second = extractDocument({ name: 'other.txt', bytes: Buffer.from('text') });
    const checkSecond = expect(second).rejects.toThrow('15 秒');
    await expect(extractDocument({ name: 'third.txt', bytes: Buffer.from('text') })).rejects.toThrow('繁忙');
    await vi.advanceTimersByTimeAsync(DOCUMENT_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledOnce(); expect(secondChild.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    child.emit('close', null); secondChild.emit('close', null);
    await check; await checkSecond;
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--max-old-space-size=256');
  });
  it('kills a parser that exceeds the output bound', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const parsed = extractDocument({ name: 'test.txt', bytes: Buffer.from('text') });
    const check = expect(parsed).rejects.toThrow('输出超过限制');
    child.stdout.write('x'.repeat(512 * 1024 + 1)); expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', null); await check;
  });
});
