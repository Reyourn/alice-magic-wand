import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGES, type ImageAttachment } from '../src/shared/types.js';
import { imageSelectionError, messageImages, MessageImages } from '../src/client/image-attachments.js';

const png = { name: '界面截图.png', type: 'image/png', size: 100 };
const image: ImageAttachment = { id: 'image-1', name: png.name, mimeType: 'image/png', size: png.size, url: '/api/attachments/image-1' };

describe('image composer constraints', () => {
  it('accepts supported screenshot formats through the documented size/count limit', () => {
    expect(imageSelectionError([png], MAX_MESSAGE_IMAGES - 1)).toBeUndefined();
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(imageSelectionError([{ ...png, type, size: MAX_IMAGE_BYTES }], 0)).toBeUndefined();
    }
    expect(imageSelectionError([{ ...png, type: '' }], 0)).toBeUndefined();
    expect(imageSelectionError([{ ...png, type: 'application/octet-stream' }], 0)).toBeUndefined();
  });
  it('rejects oversized, empty and unsupported files with an actionable Chinese error', () => {
    expect(imageSelectionError([{ ...png, size: MAX_IMAGE_BYTES + 1 }], 0)).toContain('超过 5 MiB');
    expect(imageSelectionError([{ ...png, size: 0 }], 0)).toContain('空文件');
    for (const type of ['image/svg+xml', 'application/pdf', 'text/html']) {
      expect(imageSelectionError([{ ...png, type }], 0)).toContain('格式不支持');
    }
  });
  it('includes already selected files when enforcing the per-message limit', () => {
    expect(imageSelectionError([png], MAX_MESSAGE_IMAGES)).toContain('最多添加 4 个附件');
    expect(imageSelectionError([png, png], MAX_MESSAGE_IMAGES - 1)).toContain('请先移除');
  });
});

describe('message image history', () => {
  it('accepts only valid local image metadata and rejects external/data/traversal links', () => {
    expect(messageImages([image])).toEqual([image]);
    for (const url of ['https://example.org/image.png', '//example.org/image.png', 'data:image/png;base64,a', 'javascript:alert(1)', '/api/attachments/../state', '/api/attachments/image-1?other=1']) {
      expect(messageImages([{ ...image, url }])).toEqual([]);
    }
    expect(messageImages([null, {}, { ...image, mimeType: 'image/svg+xml' }, { ...image, size: 0 }])).toEqual([]);
    expect(messageImages(undefined)).toEqual([]);
  });
  it('provides accessible thumbnails linking to the original image in a new tab', () => {
    const html = renderToStaticMarkup(createElement(MessageImages, { images: [image] }));
    expect(html).toContain('aria-label="查看图片：界面截图.png（新标签页）"');
    expect(html).toContain('href="/api/attachments/image-1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('alt="界面截图.png"');
  });
});
