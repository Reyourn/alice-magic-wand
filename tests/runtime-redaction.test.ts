import { describe, expect, it } from 'vitest';
import { JsonLines, safeData, safeText } from '../src/server/runtime/process.js';

describe('native error text redaction', () => {
  it('omits image payloads from structured native diagnostics and data URLs', () => {
    expect(safeData({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'synthetic-image' } }, { type: 'image', mimeType: 'image/png', data: 'synthetic-tool-image' }], inputTokens: 123 }))
      .toEqual({ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '[IMAGE DATA OMITTED]' } }, { type: 'image', mimeType: 'image/png', data: '[IMAGE DATA OMITTED]' }], inputTokens: 123 });
    expect(safeText('图片失败 data:image/png;base64,YWJjZA==，请重试')).toBe('图片失败 [IMAGE DATA OMITTED]，请重试');
    expect(safeData({ type: 'text', data: '正常工具输出' })).toEqual({ type: 'text', data: '正常工具输出' });
  });

  it('accepts bounded large native image echoes without losing the following terminal frame', () => {
    const received: string[] = []; let malformed = 0;
    const parser = new JsonLines(frame => received.push(frame.type), () => { malformed++; });
    parser.push('{"type":"user","content":"' + 'A'.repeat(17 * 1024 * 1024));
    parser.push('"}\n{"type":"result"}\n');
    expect(received).toEqual(['user', 'result']); expect(malformed).toBe(0);
  });

  it('redacts quoted JSON credentials inside Chinese diagnostics while preserving readable JSON', () => {
    const diagnostic = JSON.stringify({ error: '模型目录读取失败', api_key: 'synthetic-only', access_token: 'another-synthetic-value', model: 'native-model' });
    expect(JSON.parse(safeText(diagnostic))).toEqual({ error: '模型目录读取失败', api_key: '[REDACTED]', access_token: '[REDACTED]', model: 'native-model' });
  });

  it('removes whole single- and double-quoted values, including spaces and escaped quotes', () => {
    expect(safeText("读取失败 {'password': 'synthetic value', secret=\"another synthetic value\"}"))
      .toBe("读取失败 {'password': '[REDACTED]', secret=\"[REDACTED]\"}");
    const diagnostic = JSON.stringify({ apiKey: 'synthetic "quoted" value', secret: "synthetic 'value'" });
    expect(JSON.parse(safeText(diagnostic))).toEqual({ apiKey: '[REDACTED]', secret: '[REDACTED]' });
  });

  it('redacts authorization headers and bare Bearer credentials including base64 punctuation', () => {
    expect(safeText('Authorization: Bearer synthetic+/==; 模型目录失败')).toBe('Authorization: [REDACTED]; 模型目录失败');
    expect(safeText('认证失败 Bearer synthetic+/==')).toBe('认证失败 Bearer [REDACTED]');
    expect(safeText('{"authorization":"Bearer synthetic+/=="}')).toBe('{"authorization":"[REDACTED]"}');
  });

  it('keeps normal model metadata and repeated redaction stable', () => {
    const diagnostic = '模型目录失败 api_key=synthetic-value, model=native-model; inputTokens=123';
    const redacted = '模型目录失败 api_key=[REDACTED], model=native-model; inputTokens=123';
    expect(safeText(diagnostic)).toBe(redacted);
    expect(safeText(safeText(diagnostic))).toBe(redacted);
    expect(safeText('native-model 目录读取超时')).toBe('native-model 目录读取超时');
  });
});
