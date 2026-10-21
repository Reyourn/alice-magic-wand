export const IMAGE_MIME_BY_EXTENSION:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
export const DOCUMENT_MIME_BY_EXTENSION:Record<string,string>={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
export const TEXT_FILE_EXTENSIONS=['txt','md','mdx','rst','tex','csv','tsv','json','jsonl','ndjson','yaml','yml','xml','html','htm','css','scss','less','js','jsx','mjs','cjs','ts','tsx','py','sql','log','ini','toml','c','h','cpp','hpp','cs','java','go','rs','sh','ps1','bat','vue','svelte','kt','swift','rb','php'];
const textExtensions=new Set(TEXT_FILE_EXTENSIONS);
const textNames=new Set(['readme','license','dockerfile','makefile','.gitignore','.editorconfig']);
export function fileExtension(name:string):string{return name.split(/[\\/]/).at(-1)?.toLowerCase().split('.').slice(1).at(-1)??'';}
export function supportedFileFormat(name:string):'text'|'pdf'|'docx'|'xlsx'|'pptx'|undefined {
  const ext=fileExtension(name);
  if(ext==='pdf'||ext==='docx'||ext==='xlsx'||ext==='pptx')return ext;
  if(textExtensions.has(ext)||textNames.has(name.split(/[\\/]/).at(-1)?.toLowerCase()??''))return 'text';
}
export const ATTACHMENT_ACCEPT=[...Object.values(IMAGE_MIME_BY_EXTENSION),...Object.keys(DOCUMENT_MIME_BY_EXTENSION).map(ext=>`.${ext}`),...TEXT_FILE_EXTENSIONS.map(ext=>`.${ext}`)].join(',');
