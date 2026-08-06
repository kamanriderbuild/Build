/**
 * Offline Word (.docx) builder using JSZip.
 * Produces a readable inspection report with headings, descriptions, and photos.
 */
(function (global) {
  function xmlEscape(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function paragraph(text, opts) {
    const o = opts || {};
    const size = o.size || 21; // half-points, 21 ~= 10.5pt
    const bold = o.bold ? '<w:b/>' : '';
    const color = o.color ? `<w:color w:val="${o.color}"/>` : '';
    const before = o.before != null ? o.before : 120;
    const after = o.after != null ? o.after : 120;
    const align = o.align ? `<w:jc w:val="${o.align}"/>` : '';
    const lines = String(text || '').split(/\r?\n/);
    const runs = lines
      .map((line, idx) => {
        const br = idx < lines.length - 1 ? '<w:br/>' : '';
        return `<w:r><w:rPr>${bold}${color}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/></w:rPr><w:t xml:space="preserve">${xmlEscape(line)}</w:t>${br}</w:r>`;
      })
      .join('');
    return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${align}</w:pPr>${runs || '<w:r><w:t></w:t></w:r>'}</w:p>`;
  }

  function imageParagraph(relId, cx, cy) {
    return `
      <w:p>
        <w:pPr><w:spacing w:before="80" w:after="160"/><w:jc w:val="center"/></w:pPr>
        <w:r>
          <w:drawing>
            <wp:inline distT="0" distB="0" distL="0" distR="0">
              <wp:extent cx="${cx}" cy="${cy}"/>
              <wp:docPr id="${relId.replace(/\D/g, '') || 1}" name="Picture"/>
              <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                    <pic:nvPicPr>
                      <pic:cNvPr id="0" name="image"/>
                      <pic:cNvPicPr/>
                    </pic:nvPicPr>
                    <pic:blipFill>
                      <a:blip r:embed="${relId}"/>
                      <a:stretch><a:fillRect/></a:stretch>
                    </pic:blipFill>
                    <pic:spPr>
                      <a:xfrm>
                        <a:off x="0" y="0"/>
                        <a:ext cx="${cx}" cy="${cy}"/>
                      </a:xfrm>
                      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                    </pic:spPr>
                  </pic:pic>
                </a:graphicData>
              </a:graphic>
            </wp:inline>
          </w:drawing>
        </w:r>
      </w:p>`;
  }

  async function normalizeImage(blob, maxEdge) {
    const max = maxEdge || 1280;
    const bitmap = await createImageBitmap(blob);
    let w = bitmap.width;
    let h = bitmap.height;
    const scale = Math.min(1, max / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();

    const outBlob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b || blob), 'image/jpeg', 0.85);
    });
    return { blob: outBlob, width: w, height: h, ext: 'jpeg' };
  }

  function pxToEmu(px) {
    // 96 dpi assumption
    return Math.round((px / 96) * 914400);
  }

  async function buildInspectionDocx(options) {
    if (typeof JSZip === 'undefined') throw new Error('打包组件未加载');
    const {
      title,
      plate,
      note,
      createdAt,
      parts,
      getPhotoBlob,
      onlyPart
    } = options;

    const zip = new JSZip();
    const media = zip.folder('word/media');
    const rels = [];
    const body = [];

    body.push(paragraph(title || '车子验车报告', { bold: true, size: 36, align: 'center', before: 0, after: 200 }));
    body.push(paragraph(`车牌：${plate || '未填写'}`, { size: 22 }));
    if (note) body.push(paragraph(`备注：${note}`, { size: 20 }));
    if (createdAt) body.push(paragraph(`生成时间：${createdAt}`, { size: 18, color: '666666' }));
    body.push(paragraph('说明：以下按车辆部位列出车况描述与照片。', { size: 18, color: '666666', after: 240 }));

    let imageIndex = 0;
    let contentCount = 0;
    const partList = onlyPart ? [onlyPart] : parts.map((p) => p.name);

    for (const partName of partList) {
      const part = parts.find((p) => p.name === partName) || { name: partName, description: '', photos: [] };
      const hasDesc = !!(part.description && String(part.description).trim());
      const photos = part.photos || [];
      if (!hasDesc && !photos.length) continue;

      contentCount += 1;
      body.push(paragraph(part.name, { bold: true, size: 28, before: 280, after: 80, color: '0F2744' }));
      body.push(
        paragraph(hasDesc ? `车况描述：${part.description}` : '车况描述：（无）', {
          size: 20,
          after: 120
        })
      );

      for (const photo of photos) {
        const row = await getPhotoBlob(photo.id);
        const normalized = await normalizeImage(row.blob, 1200);
        imageIndex += 1;
        const fileName = `image${imageIndex}.${normalized.ext}`;
        media.file(fileName, normalized.blob);
        const relId = `rId${imageIndex + 10}`;
        rels.push({ id: relId, target: `media/${fileName}` });

        let cx = pxToEmu(normalized.width);
        let cy = pxToEmu(normalized.height);
        const maxCx = pxToEmu(520);
        if (cx > maxCx) {
          const ratio = maxCx / cx;
          cx = maxCx;
          cy = Math.round(cy * ratio);
        }
        body.push(imageParagraph(relId, cx, cy));
        if (photo.filename) {
          body.push(paragraph(photo.filename, { size: 16, color: '888888', align: 'center', before: 0, after: 80 }));
        }
      }
    }

    if (!contentCount) throw new Error(onlyPart ? '该部位暂无内容可导出' : '暂无照片或描述可导出');

    body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>');

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${body.join('\n')}
  </w:body>
</w:document>`;

    const relXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`
    )
    .join('\n')}
</Relationships>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:rPr>
      <w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>
      <w:sz w:val="21"/>
    </w:rPr>
  </w:style>
</w:styles>`;

    zip.file('[Content_Types].xml', contentTypes);
    zip.folder('_rels').file('.rels', rootRels);
    zip.folder('word').file('document.xml', documentXml);
    zip.folder('word').file('styles.xml', stylesXml);
    zip.folder('word').folder('_rels').file('document.xml.rels', relXml);

    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  global.CheziDocx = { buildInspectionDocx };
})(window);
