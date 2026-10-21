import { useEffect, useId, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Bounded display parser; quoted newlines, escaped quotes and empty cells stay intact. */
export function parseCsvPreview(text: string, maxRows = 200): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const value = text[index];
    if (value === '"') { if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted; }
    else if (!quoted && value === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (value === '\n' || value === '\r')) {
      if (value === '\r' && text[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length >= maxRows) return { rows, truncated: index < text.length - 1 };
    } else cell += value;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return { rows, truncated: false };
}

export function MermaidPreview({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [image, setImage] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let active = true, url = ''; setImage(''); setError('');
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', suppressErrorRendering: true, maxTextSize: 50000, flowchart: { htmlLabels: false } });
      const rendered = await mermaid.render(`diagram${id}`, source);
      if (!active) return;
      url = URL.createObjectURL(new Blob([rendered.svg], { type: 'image/svg+xml' })); setImage(url);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '图表无法渲染'); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [source, id]);
  return <div className="artifact-diagram">{image ? <img src={image} alt="Mermaid 图表预览" /> : error ? <p role="alert">图表渲染失败：{error}</p> : <p>正在生成图表预览…</p>}<details><summary>查看图表源码</summary><pre>{source}</pre></details></div>;
}

export function ArtifactText({ title, text }: { title: string; text: string }) {
  if (/\.m(?:ermaid|md)$/i.test(title)) return <MermaidPreview source={text} />;
  if (/\.(?:md|mdown|markdown)$/i.test(title)) return <article className="artifact-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: props => <a {...props} target="_blank" rel="noreferrer" />, img: ({ alt }) => <span>[图片：{alt || '请在原件中查看'}]</span>, code: ({ className, children }) => className === 'language-mermaid' ? <MermaidPreview source={String(children).replace(/\n$/, '')} /> : <code className={className}>{children}</code> }}>{text}</Markdown></article>;
  if (/\.csv$/i.test(title)) { const data = parseCsvPreview(text); return <><div className="artifact-table-scroll"><table aria-label="CSV 数据预览"><tbody>{data.rows.map((row, index) => <tr key={index}><th scope="row">{index + 1}</th>{row.slice(0, 100).map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody></table></div><p className="field-note">按文本保留原始值{data.truncated ? '；仅展示前 200 行' : ''}。此预览不会重新计算公式。</p></>; }
  return <pre className="artifact-text-preview">{text || '没有可提取的预览内容，请下载原件查看。'}</pre>;
}
