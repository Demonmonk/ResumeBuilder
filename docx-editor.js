// docx-editor.js
// DOCX = ZIP of XML files. We use native DecompressionStream/CompressionStream
// for ZIP handling and direct string surgery on the XML to avoid namespace issues.

// ── CRC-32 ─────────────────────────────────────────────────────────────────────
const CRC32 = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let c = 0xFFFFFFFF;
  for (const b of data) c = CRC32[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Stream helpers ─────────────────────────────────────────────────────────────
async function streamTransform(data, stream) {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
  writer.close();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let i = 0;
  for (const c of chunks) { out.set(c, i); i += c.length; }
  return out;
}
const inflate = d => streamTransform(d, new DecompressionStream('deflate-raw'));
const deflate = d => streamTransform(d, new CompressionStream('deflate-raw'));

// ── ZIP reader ─────────────────────────────────────────────────────────────────
async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  const files = {};

  // Find End of Central Directory
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid ZIP/DOCX file');

  const cdCount  = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014B50) break;
    const method     = view.getUint16(pos + 10, true);
    const cSize      = view.getUint32(pos + 20, true);
    const nameLen    = view.getUint16(pos + 28, true);
    const extraLen   = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const lhOffset   = view.getUint32(pos + 42, true);
    const name       = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));

    const lhNameLen  = view.getUint16(lhOffset + 26, true);
    const lhExtraLen = view.getUint16(lhOffset + 28, true);
    const dataStart  = lhOffset + 30 + lhNameLen + lhExtraLen;
    const compressed = bytes.slice(dataStart, dataStart + cSize);

    files[name] = method === 8 ? await inflate(compressed) : new Uint8Array(compressed);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ── ZIP writer ─────────────────────────────────────────────────────────────────
async function zip(files) {
  const enc = new TextEncoder();
  const entries = [];
  let offset = 0;

  for (const [name, data] of Object.entries(files)) {
    const nameBytes  = enc.encode(name);
    const compressed = await deflate(data);
    const useDeflate = compressed.length < data.length;
    const fileData   = useDeflate ? compressed : data;
    const method     = useDeflate ? 8 : 0;
    const checksum   = crc32(data);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0,  0x04034B50, true);
    lv.setUint16(4,  20,         true);
    lv.setUint16(6,  0,          true);
    lv.setUint16(8,  method,     true);
    lv.setUint16(10, 0,          true); lv.setUint16(12, 0, true);
    lv.setUint32(14, checksum,           true);
    lv.setUint32(18, fileData.length,    true);
    lv.setUint32(22, data.length,        true);
    lv.setUint16(26, nameBytes.length,   true);
    lv.setUint16(28, 0,                  true);
    lh.set(nameBytes, 30);

    entries.push({ nameBytes, data, fileData, checksum, method, offset, lh });
    offset += lh.length + fileData.length;
  }

  // Central directory
  const cds = [];
  let cdLen = 0;
  for (const e of entries) {
    const cd = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0,  0x02014B50,        true);
    cv.setUint16(4,  20,                true); cv.setUint16(6, 20, true);
    cv.setUint16(8,  0,                 true);
    cv.setUint16(10, e.method,          true);
    cv.setUint16(12, 0,                 true); cv.setUint16(14, 0, true);
    cv.setUint32(16, e.checksum,        true);
    cv.setUint32(20, e.fileData.length, true);
    cv.setUint32(24, e.data.length,     true);
    cv.setUint16(28, e.nameBytes.length,true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0,          true);
    cv.setUint32(42, e.offset,   true);
    cd.set(e.nameBytes, 46);
    cds.push(cd);
    cdLen += cd.length;
  }

  const eocd = new Uint8Array(22);
  const ev   = new DataView(eocd.buffer);
  ev.setUint32(0,  0x06054B50,       true);
  ev.setUint16(4,  0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8,  entries.length,   true);
  ev.setUint16(10, entries.length,   true);
  ev.setUint32(12, cdLen,            true);
  ev.setUint32(16, offset,           true);
  ev.setUint16(20, 0,                true);

  const total = new Uint8Array(offset + cdLen + 22);
  let p = 0;
  for (const e of entries) { total.set(e.lh, p); p += e.lh.length; total.set(e.fileData, p); p += e.fileData.length; }
  for (const cd of cds)    { total.set(cd, p);  p += cd.length; }
  total.set(eocd, p);
  return total;
}

// ── XML string helpers (avoids XMLSerializer namespace issues) ─────────────────
function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Extract all <w:t> content from a paragraph XML string
function getParaText(paraXml) {
  return (paraXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [])
    .map(m => m.replace(/<w:t[^>]*>/,'').replace(/<\/w:t>/,''))
    .join('');
}

// Split full document XML into paragraph blocks [{start, end, xml}]
function findParagraphs(docXml) {
  const results = [];
  let search = 0;
  while (true) {
    const start = docXml.indexOf('<w:p ', search);
    const start2 = docXml.indexOf('<w:p>', search);
    const s = (start === -1) ? start2 : (start2 === -1) ? start : Math.min(start, start2);
    if (s === -1) break;
    const end = docXml.indexOf('</w:p>', s);
    if (end === -1) break;
    results.push({ start: s, end: end + 6, xml: docXml.slice(s, end + 6) });
    search = end + 6;
  }
  return results;
}

// Replace ALL <w:t> content in a paragraph: put newText in first run, blank the rest
function setParaText(paraXml, newText) {
  let first = true;
  return paraXml.replace(/<w:t([^>]*)>([^<]*)<\/w:t>/g, (_m, attrs, _old) => {
    if (first) { first = false; return `<w:t xml:space="preserve">${xmlEsc(newText)}</w:t>`; }
    return '<w:t></w:t>';
  });
}

// ── Extract plain text from a DOCX (base64) — free, no Claude needed ──────────
async function extractDocxText(base64) {
  const bin   = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const files = await unzip(bytes.buffer);
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes) throw new Error('No word/document.xml found — is this a valid .docx?');

  const docXml = new TextDecoder('utf-8').decode(xmlBytes);
  const paras  = findParagraphs(docXml);
  return paras.map(p => getParaText(p.xml)).filter(t => t.trim()).join('\n');
}

// ── Apply accepted changes + additions to a DOCX (base64 → base64) ────────────
async function applyChangesToDocx(base64, changes, additions) {
  const bin   = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const files = await unzip(bytes.buffer);
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes) throw new Error('No word/document.xml found');

  let docXml = new TextDecoder('utf-8').decode(xmlBytes);

  // ── Apply changes (swap bullets) ──────────────────────────────────────────
  for (const change of changes) {
    if (!change.original) continue;
    const paras = findParagraphs(docXml);
    for (const para of paras) {
      const text = getParaText(para.xml);
      if (text.includes(change.original)) {
        const newText = text.replace(change.original, change.suggested || '');
        const newPara = setParaText(para.xml, newText);
        docXml = docXml.slice(0, para.start) + newPara + docXml.slice(para.end);
        break; // only replace first match
      }
    }
  }

  // ── Apply additions (insert new bullets) ──────────────────────────────────
  for (const addition of additions) {
    const bullet = (addition.bullet || '').trim();
    if (!bullet) continue;

    const sectionUpper = (addition.section || '').toUpperCase().trim();
    let insertAt  = -1;
    let template  = null;

    const paras = findParagraphs(docXml);
    for (let i = 0; i < paras.length; i++) {
      const text = getParaText(paras[i].xml).trim().toUpperCase();
      if (sectionUpper && text === sectionUpper) {
        // Find a nearby content paragraph to use as formatting template
        for (let j = i + 1; j < Math.min(i + 8, paras.length); j++) {
          if (getParaText(paras[j].xml).trim().length > 10) {
            template  = paras[j].xml;
            insertAt  = paras[j].end;
            break;
          }
        }
        if (insertAt === -1) insertAt = paras[i].end;
        break;
      }
    }

    // Clone the template paragraph with new text, or use a minimal paragraph
    const newPara = template
      ? setParaText(template, bullet)
      : `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(bullet)}</w:t></w:r></w:p>`;

    if (insertAt !== -1) {
      docXml = docXml.slice(0, insertAt) + '\n' + newPara + docXml.slice(insertAt);
    } else {
      // Append before </w:body>
      const bodyClose = docXml.lastIndexOf('</w:body>');
      if (bodyClose !== -1)
        docXml = docXml.slice(0, bodyClose) + newPara + '\n' + docXml.slice(bodyClose);
    }
  }

  // Pack modified XML back into the ZIP
  files['word/document.xml'] = new TextEncoder().encode(docXml);
  const newZip = await zip(files);

  // Convert to base64
  let b64 = '';
  for (let i = 0; i < newZip.length; i += 8192)
    b64 += String.fromCharCode(...newZip.slice(i, i + 8192));
  return btoa(b64);
}

// ── Download helpers ───────────────────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function downloadDocx(base64, filename) {
  const bin  = atob(base64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  downloadBlob(
    new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    filename + '.docx'
  );
}
