import JSZip from 'jszip';

/** Real OOXML package; slide file numbering deliberately differs from presentation order. */
export async function createPptxFixture(code = 'PPTX-SENTINEL-4268') {
  const zip = new JSZip();
  const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const paragraph = text => `<a:p><a:r><a:rPr lang="zh-CN"/><a:t>${escape(text)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>`;
  const shape = (id, text) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="文本 ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraph(text)}</p:txBody></p:sp>`;
  const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const slide = content => `<p:sld xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}"><p:cSld><p:spTree>${tree}${content}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const cell = text => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph(text)}</a:txBody><a:tcPr/></a:tc>`;
  const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="客户运营数据"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="2000000"/></p:xfrm><a:graphic><a:graphicData uri="${a}/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="2500000"/><a:gridCol w="2500000"/></a:tblGrid><a:tr h="1000000">${cell('指标')}${cell('统计结果')}</a:tr><a:tr h="1000000">${cell('客户总数')}${cell('2689')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`);
  const relationships = rows => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.map(([id, type, target]) => `<Relationship Id="${id}" Type="${r}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
  zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'ppt/presentation.xml']]));
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', relationships([['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml']]));
  zip.file('ppt/slides/slide2.xml', slide(shape(2, '2022年12月客户运营报告') + shape(3, `文件验证码：${code}`) + table));
  zip.file('ppt/slides/slide1.xml', slide(shape(2, '第二页：行动计划') + shape(3, '下月优先跟进客户满意度；第二页验证码：SLIDE2-9057')));
  zip.file('ppt/slides/_rels/slide1.xml.rels', relationships([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]));
  zip.file('ppt/notesSlides/notesSlide1.xml', `<p:notes xmlns:p="${p}" xmlns:a="${a}" xmlns:r="${r}"><p:cSld><p:spTree>${tree}${shape(2, '演讲者备注：仅使用合成数据进行验收，备注验证码 NOTE-4716。')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
  zip.file('ppt/notesSlides/_rels/notesSlide1.xml.rels', relationships([['rId1', 'slide', '../slides/slide1.xml']]));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
