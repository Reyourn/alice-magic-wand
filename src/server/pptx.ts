import { posix } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { MAX_DOCUMENT_CHARACTERS, type ExtractedDocument } from './documents.js';
import { readOfficeXmlParts } from './document-zip.js';

const MAX_SLIDES = 100;
const P = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main']);
const A = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main']);
const R = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']);
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MIME_PREFIX = 'application/vnd.openxmlformats-officedocument.presentationml.';

function invalid(detail: string): Error { return new Error(`PowerPoint 文档无法解析：${detail}。`); }
function attr(tag: SaxesTagNS, name: string, namespaces?: Set<string>): string | undefined {
  return Object.values(tag.attributes).find(value => value.local === name && (namespaces ? namespaces.has(value.uri) : !value.uri))?.value;
}
function is(tag: SaxesTagNS | undefined, namespaces: Set<string>, local: string): boolean { return !!tag && namespaces.has(tag.uri) && tag.local === local; }
type XmlHandlers = { open?: (tag: SaxesTagNS, parents: SaxesTagNS[]) => void; close?: (tag: SaxesTagNS, parents: SaxesTagNS[]) => void; text?: (text: string, parents: SaxesTagNS[]) => void; };
function xml(parts: Map<string, Buffer>, name: string, namespaces: Set<string>, root: string, handlers: XmlHandlers): void {
  const bytes = parts.get(name);
  if (!bytes) throw invalid(`缺少部件 ${name}`);
  const parser = new SaxesParser({ xmlns: true }), stack: SaxesTagNS[] = [];
  parser.on('doctype', () => { throw invalid('不支持包含 DTD 或自定义实体的 XML'); });
  parser.on('error', () => { throw invalid(`XML 部件损坏（${name}）`); });
  parser.on('opentag', tag => {
    if (!stack.length && !is(tag, namespaces, root)) throw invalid(`部件类型不符（${name}）`);
    if (stack.length >= 256) throw invalid('XML 层级超过限制');
    handlers.open?.(tag, stack); stack.push(tag);
  });
  parser.on('closetag', tag => { stack.pop(); handlers.close?.(tag, stack); });
  const text = (value: string) => handlers.text?.(value, stack);
  parser.on('text', text); parser.on('cdata', text);
  let source: string;
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch { throw invalid(`XML 编码无效（${name}）`); }
  parser.write(source).close();
}
interface Relationship { type: string; target: string; external: boolean; }
function relationships(parts: Map<string, Buffer>, owner: string, optional = false): Map<string, Relationship> {
  const name = `${posix.dirname(owner)}/_rels/${posix.basename(owner)}.rels`, result = new Map<string, Relationship>();
  if (optional && !parts.has(name)) return result;
  xml(parts, name, new Set([PACKAGE_REL]), 'Relationships', { open(tag, parents) {
    if (parents.length !== 1 || tag.uri !== PACKAGE_REL || tag.local !== 'Relationship') return;
    const id = attr(tag, 'Id'), type = attr(tag, 'Type'), target = attr(tag, 'Target'), mode = attr(tag, 'TargetMode');
    if (!id || !type || !target || result.has(id) || (mode && mode !== 'External' && mode !== 'Internal')) throw invalid(`部件关系无效（${name}）`);
    result.set(id, { type, target, external: mode === 'External' });
  } });
  return result;
}
function relationKind(relation: Relationship, kind: string): boolean { return [...R].some(namespace => relation.type === `${namespace}/${kind}`); }
function targetPart(owner: string, relation: Relationship): string {
  if (relation.external) throw invalid('幻灯片或备注引用了外部内容');
  let target: string;
  try { target = decodeURIComponent(relation.target); } catch { throw invalid('部件关系路径无效'); }
  if (/[\\\u0000-\u001f:?#]/.test(target) || target.startsWith('//')) throw invalid('部件关系路径无效');
  const segments = target.startsWith('/') ? [] : posix.dirname(owner).split('/');
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!segments.length) throw invalid('部件关系超出文档范围'); segments.pop(); }
    else segments.push(segment);
  }
  const result = segments.join('/');
  if (!result.endsWith('.xml')) throw invalid('幻灯片或备注部件格式不符');
  return result;
}
class TextOutput {
  text = ''; truncated = false; hasText = false;
  add(value: string): void {
    const available = MAX_DOCUMENT_CHARACTERS - this.text.length;
    if (value.length > available) {
      let part = value.slice(0, available);
      if (/[\uD800-\uDBFF]$/.test(part)) part = part.slice(0, -1);
      this.text += part; this.truncated = true;
    } else this.text += value;
  }
}
function drawingText(parts: Map<string, Buffer>, name: string, notes: boolean, output: TextOutput): void {
  let table = 0, row = 0, column = 0, skipShape = false;
  xml(parts, name, P, notes ? 'notes' : 'sld', {
    open(tag, parents) {
      if (is(tag, P, 'sp')) skipShape = false;
      if (notes && is(tag, P, 'ph') && ['sldImg', 'sldNum', 'hdr', 'ftr', 'dt'].includes(attr(tag, 'type') ?? '')) skipShape = true;
      if (skipShape) return;
      if (is(tag, A, 'tbl')) { table++; row = 0; }
      if (is(tag, A, 'tr')) { row++; column = 0; output.add(`[表格 ${table} 第 ${row} 行]\n`); }
      if (is(tag, A, 'tc')) { column++; output.add(`[单元格 ${column}] `); }
      if (is(tag, A, 'br') && is(parents.at(-1), A, 'p')) output.add('\n');
    },
    close(tag) {
      if (!skipShape && is(tag, A, 'p')) output.add('\n');
      if (is(tag, P, 'sp')) skipShape = false;
    },
    text(value, parents) {
      const parent = parents.at(-2);
      if (skipShape || !is(parents.at(-1), A, 't') || (!is(parent, A, 'r') && !is(parent, A, 'fld'))) return;
      if (value.trim()) output.hasText = true;
      output.add(value);
    },
  });
}

export function extractPptx(bytes: Buffer): ExtractedDocument {
  const parts = readOfficeXmlParts(bytes, 'ppt/presentation.xml'), types = new Map<string, string>();
  xml(parts, '[Content_Types].xml', new Set([CONTENT_TYPES]), 'Types', { open(tag, parents) {
    if (parents.length !== 1 || tag.uri !== CONTENT_TYPES || tag.local !== 'Override') return;
    const name = attr(tag, 'PartName'), type = attr(tag, 'ContentType');
    if (!name || !type || types.has(name)) throw invalid('内容类型声明无效');
    types.set(name, type);
  } });
  const checkPart = (name: string, type: string) => {
    if (!parts.has(name)) throw invalid(`缺少部件 ${name}`);
    if (types.get(`/${name}`) !== `${MIME_PREFIX}${type}+xml`) throw invalid(`内容类型不符（${name}）`);
  };
  checkPart('ppt/presentation.xml', 'presentation.main');
  const relations = relationships(parts, 'ppt/presentation.xml'), slides: string[] = [], ids = new Set<string>();
  xml(parts, 'ppt/presentation.xml', P, 'presentation', { open(tag, parents) {
    if (!is(tag, P, 'sldId') || parents.length !== 2 || !is(parents[1], P, 'sldIdLst')) return;
    const id = attr(tag, 'id', R), relation = id ? relations.get(id) : undefined;
    if (!id || ids.has(id) || !relation || !relationKind(relation, 'slide')) throw invalid('幻灯片顺序或关联关系损坏');
    ids.add(id);
    const name = targetPart('ppt/presentation.xml', relation); checkPart(name, 'slide'); slides.push(name);
  } });
  if (!slides.length) throw new Error('PowerPoint 没有可提取的幻灯片文字；图片暂不支持 OCR。');
  const result = new TextOutput(); let slidesRead = 0;
  for (const [index, slide] of slides.slice(0, MAX_SLIDES).entries()) {
    result.add(`[第 ${index + 1} 张幻灯片]\n`);
    drawingText(parts, slide, false, result); slidesRead++;
    const notes = [...relationships(parts, slide, true).values()].filter(relation => relationKind(relation, 'notesSlide'));
    if (notes.length > 1) throw invalid('一张幻灯片关联了多份备注');
    if (notes[0]) {
      const name = targetPart(slide, notes[0]); checkPart(name, 'notesSlide');
      result.add(`[第 ${index + 1} 张备注]\n`); drawingText(parts, name, true, result);
    }
    result.add('\n');
    if (result.truncated) break;
  }
  if (!result.hasText) throw new Error('PowerPoint 没有可提取的文字；图片、图表暂不支持 OCR 或内容识别。');
  if (slidesRead < slides.length) result.truncated = true;
  return { text: result.text, format: 'PPTX', truncated: result.truncated, detail: `按演示顺序读取 ${slidesRead}/${slides.length} 张幻灯片（最多 ${MAX_SLIDES} 张），含文本、表格文字和备注；不读取图片、图表内容或视觉排版${result.truncated ? '；内容已截断（最多 40,000 字符、100 张幻灯片）' : ''}` };
}
