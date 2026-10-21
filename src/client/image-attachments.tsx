import { useEffect, useRef, useState } from 'react';
import { FileCode2, FileSpreadsheet, FileText, Presentation, X } from 'lucide-react';
import { isImageAttachment, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_MESSAGE_ATTACHMENTS, type Attachment, type FileAttachment, type ImageAttachment } from '../shared/types.js';
import { ATTACHMENT_ACCEPT, IMAGE_MIME_BY_EXTENSION, fileExtension, supportedFileFormat } from '../shared/attachment-formats.js';

export const imageAccept = [...new Set(Object.values(IMAGE_MIME_BY_EXTENSION))].join(',');
export const attachmentAccept = ATTACHMENT_ACCEPT;
const supportedTypes = new Set(imageAccept.split(','));
type SelectedFile = Pick<File, 'name' | 'type' | 'size'>;
const isImageFile = (file: SelectedFile) => supportedTypes.has(file.type)
  || ((!file.type || file.type === 'application/octet-stream') && !!IMAGE_MIME_BY_EXTENSION[fileExtension(file.name)]);
export interface DraftImage { id: string; file: File; previewUrl?: string; uploaded?: Attachment; }

export function imageSelectionError(files: readonly SelectedFile[], existing: number): string | undefined {
  if (files.length + existing > MAX_MESSAGE_ATTACHMENTS) return `每条指令最多添加 ${MAX_MESSAGE_ATTACHMENTS} 个附件（含图片），请先移除部分附件。`;
  for (const file of files) {
    const image = isImageFile(file);
    if (!image && !supportedFileFormat(file.name)) return `「${file.name}」格式不支持，请选择图片、PDF、DOCX、XLSX、PPTX 或常见文本与代码文件。`;
    if (file.size === 0) return `「${file.name}」是空文件，请重新选择附件。`;
    if (file.size > (image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) return `「${file.name}」超过 ${image ? 5 : 20} MiB，请缩小后再添加。`;
  }
}

/** Accept only locally served attachment records, never arbitrary URLs from runtime events. */
export function messageAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Attachment => {
    if (!item || typeof item !== 'object') return false;
    const attachment = item as Partial<FileAttachment>;
    if (typeof attachment.id !== 'string' || typeof attachment.name !== 'string'
      || typeof attachment.mimeType !== 'string' || typeof attachment.size !== 'number'
      || !Number.isFinite(attachment.size) || attachment.size <= 0
      || typeof attachment.url !== 'string' || !/^\/api\/attachments\/[a-zA-Z0-9_-]+$/.test(attachment.url)) return false;
    if (attachment.kind === 'file') {
      const extraction = attachment.extraction;
      return attachment.size <= MAX_FILE_BYTES && !!extraction
        && ['ready', 'truncated'].includes(extraction.status)
        && Number.isFinite(extraction.characters) && extraction.characters >= 0
        && typeof extraction.detail === 'string';
    }
    return attachment.kind === undefined && supportedTypes.has(attachment.mimeType) && attachment.size <= MAX_IMAGE_BYTES;
  }).slice(0, MAX_MESSAGE_ATTACHMENTS);
}

export function messageImages(value: unknown): ImageAttachment[] {
  return messageAttachments(value).filter(isImageAttachment);
}

export function useDraftImages() {
  const [images, setImages] = useState<DraftImage[]>([]);
  const current = useRef<DraftImage[]>([]);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // Dropping a file outside the composer must not navigate away from the workbench.
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      mounted.current = false;
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
      for (const image of current.current) if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
      current.current = [];
    };
  }, []);
  const add = (files: File[]) => {
    if (!files.length) return;
    const issue = imageSelectionError(files, current.current.length);
    if (issue) { setError(issue); return; }
    const added = files.map(file => ({ id: crypto.randomUUID(), file, previewUrl: isImageFile(file) ? URL.createObjectURL(file) : undefined }));
    current.current = [...current.current, ...added];
    setImages(current.current); setError('');
  };
  const remove = (ids: ReadonlySet<string>) => {
    for (const image of current.current) if (ids.has(image.id) && image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    current.current = current.current.filter(image => !ids.has(image.id));
    if (mounted.current) { setImages(current.current); setError(''); }
  };
  return { images, current, error, setError, add, remove, mounted };
}

function fileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function FileIcon({ name }: { name: string }) {
  const ext = fileExtension(name);
  const Icon = ext === 'pptx' ? Presentation : ['xlsx', 'csv', 'tsv'].includes(ext) ? FileSpreadsheet : ['pdf', 'docx', 'txt', 'md', 'log'].includes(ext) ? FileText : FileCode2;
  return <span className="attachment-file-icon" aria-hidden="true"><Icon size={22} /></span>;
}

export function DraftImages({ images, locked, onRemove }: { images: DraftImage[]; locked: ReadonlySet<string>; onRemove: (id: string) => void }) {
  if (!images.length) return null;
  return <div className="composer-images" data-testid="composer-images" aria-label="待发送附件">
    {images.map(image => {
      const extracted = image.uploaded && !isImageAttachment(image.uploaded) ? image.uploaded.extraction : undefined;
      return <div className={`composer-image${image.previewUrl ? '' : ' composer-file'}`} key={image.id} data-testid={image.previewUrl ? 'composer-image' : 'composer-file'}>
        {image.previewUrl ? <img src={image.previewUrl} alt={`待发送图片：${image.file.name}`} /> : <FileIcon name={image.file.name} />}
        <div className="attachment-caption"><span title={image.file.name}>{image.file.name}</span><small>{fileSize(image.file.size)}</small>{extracted && <small className={extracted.status === 'truncated' ? 'attachment-truncated' : ''} title={extracted.detail}>{extracted.detail}</small>}</div>
        <button type="button" className="icon-button" disabled={locked.has(image.id)} aria-label={`移除${image.previewUrl ? '图片' : '附件'}：${image.file.name}`} onClick={() => onRemove(image.id)}><X size={13} /></button>
      </div>;
    })}
  </div>;
}

export function MessageImages({ images }: { images: Attachment[] }) {
  if (!images.length) return null;
  return <div className="message-images" data-testid="message-images" aria-label="消息附件">
    {images.map(image => isImageAttachment(image) ? <a key={image.id} className="message-image" href={image.url} target="_blank" rel="noopener noreferrer" aria-label={`查看图片：${image.name}（新标签页）`}>
      <img src={image.url} alt={image.name} loading="lazy" />
      <span>{image.name}</span>
    </a> : <a key={image.id} className="message-file" data-testid="message-file" href={image.url} download={image.name} aria-label={`下载附件：${image.name}`}>
      <FileIcon name={image.name} /><div className="attachment-caption"><span title={image.name}>{image.name}</span><small>{fileSize(image.size)} · {image.extraction.status === 'truncated' ? '已提取部分文字' : '已提取文字'}</small><small className={image.extraction.status === 'truncated' ? 'attachment-truncated' : ''}>{image.extraction.detail}</small></div>
    </a>)}
  </div>;
}
