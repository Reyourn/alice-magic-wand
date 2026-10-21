import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_FILE_BYTES, type FileAttachment, type ImageAttachment } from '../src/shared/types.js';
import { attachmentAccept, DraftImages, imageSelectionError, messageAttachments, messageImages, MessageImages } from '../src/client/image-attachments.js';

const document: FileAttachment = { kind: 'file', id: 'document-1', name: '需求说明.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 2048, url: '/api/attachments/document-1', extraction: { status: 'ready', characters: 300, detail: '已提取 300 字符正文' } };
const screenshot: ImageAttachment = { id: 'image-1', name: '截图.png', mimeType: 'image/png', size: 100, url: '/api/attachments/image-1' };

describe('file attachment selection', () => {
  it('accepts supported documents and text by name when browser MIME is empty', () => {
    expect(attachmentAccept.split(',')).toContain('.pptx');
    for (const name of ['需求.PDF', '表格.xlsx', '文档.docx', '2022年12月客户运营报告.pptx', '演示.PPTX', 'notes.md', 'sample.ts', 'README', 'Dockerfile', 'component.vue']) {
      expect(imageSelectionError([{ name, type: '', size: MAX_FILE_BYTES }], 0)).toBeUndefined();
    }
  });
  it('applies the file size limit and shared count without weakening image size limits', () => {
    expect(imageSelectionError([{ name: 'large.pdf', type: '', size: MAX_FILE_BYTES + 1 }], 0)).toContain('超过 20 MiB');
    expect(imageSelectionError([{ name: 'small.pdf', type: '', size: 10 }], 4)).toContain('最多添加 4 个附件');
    expect(imageSelectionError([{ name: 'large.png', type: '', size: MAX_FILE_BYTES }], 0)).toContain('超过 5 MiB');
    expect(imageSelectionError([{ name: 'empty.txt', type: '', size: 0 }], 0)).toContain('空文件');
    expect(imageSelectionError([{ name: 'binary.exe', type: '', size: 10 }], 0)).toContain('格式不支持');
    expect(imageSelectionError([{ name: 'old.doc', type: 'application/msword', size: 10 }], 0)).toContain('格式不支持');
    expect(imageSelectionError([{ name: 'old.ppt', type: 'application/vnd.ms-powerpoint', size: 10 }], 0)).toContain('格式不支持');
  });
  it('renders a file card with size and removal, without attempting an image preview', () => {
    const html = renderToStaticMarkup(createElement(DraftImages, { images: [{ id: 'draft-1', file: { name: '需求说明.docx', type: '', size: 2048 } as File }], locked: new Set<string>(), onRemove() {} }));
    expect(html).toContain('data-testid="composer-file"');
    expect(html).toContain('2.0 KiB');
    expect(html).toContain('aria-label="移除附件：需求说明.docx"');
    expect(html).not.toContain('<img');
  });
});

describe('file attachment history', () => {
  it('keeps mixed local attachments and rejects malformed extraction or external URLs', () => {
    expect(messageAttachments([document, screenshot])).toEqual([document, screenshot]);
    expect(messageImages([document, screenshot])).toEqual([screenshot]);
    for (const patch of [{ url: 'https://example.org/file.docx' }, { url: '/api/attachments/../state' }, { size: MAX_FILE_BYTES + 1 }, { extraction: null }, { extraction: { status: 'ready', characters: NaN, detail: 'invalid' } }]) {
      expect(messageAttachments([{ ...document, ...patch }])).toEqual([]);
    }
  });
  it('downloads the original document and displays extraction limits alongside image thumbnails', () => {
    const truncated: FileAttachment = { ...document, extraction: { status: 'truncated', characters: 40000, detail: '仅提取前 40000 字符，请缩小文件范围后补充' } };
    const html = renderToStaticMarkup(createElement(MessageImages, { images: [truncated, screenshot] }));
    expect(html).toContain('download="需求说明.docx"');
    expect(html).toContain('aria-label="下载附件：需求说明.docx"');
    expect(html).toContain('已提取部分文字');
    expect(html).toContain(truncated.extraction.detail);
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).toContain('src="/api/attachments/image-1"');
    expect(html).not.toContain('src="/api/attachments/document-1"');
  });
});
