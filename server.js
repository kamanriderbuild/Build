const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');

const PARTS = [
  '前机盖',
  '前保险杠',
  '左前大灯',
  '右前大灯',
  '左前叶子板',
  '右前叶子板',
  '左前门',
  '右前门',
  '左后叶子板',
  '右后叶子板',
  '后尾盖',
  '备胎槽',
  '左后尾灯',
  '右后尾灯',
  '左A柱',
  '右A柱',
  '左B柱',
  '右B柱',
  '左C柱',
  '右C柱',
  '左下裙边',
  '右下裙边',
  '座椅',
  '顶蓬'
];

function ensureDirs() {
  [DATA_DIR, UPLOADS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  if (!fs.existsSync(RECORDS_FILE)) {
    fs.writeFileSync(RECORDS_FILE, JSON.stringify({ records: [] }, null, 2));
  }
}

function readRecords() {
  ensureDirs();
  return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
}

function writeRecords(data) {
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(data, null, 2));
}

function getRecordDir(recordId) {
  return path.join(UPLOADS_DIR, recordId);
}

function getPartDir(recordId, partName) {
  return path.join(getRecordDir(recordId), partName);
}

function getMetaPath(recordId) {
  return path.join(getRecordDir(recordId), 'meta.json');
}

function readMeta(recordId) {
  const metaPath = getMetaPath(recordId);
  if (!fs.existsSync(metaPath)) {
    const meta = { parts: {} };
    PARTS.forEach((p) => {
      meta.parts[p] = { description: '', photos: [] };
    });
    return meta;
  }
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function writeMeta(recordId, meta) {
  const dir = getRecordDir(recordId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getMetaPath(recordId), JSON.stringify(meta, null, 2));
}

function countPhotos(recordId) {
  const meta = readMeta(recordId);
  const counts = {};
  let total = 0;
  PARTS.forEach((p) => {
    const n = (meta.parts[p]?.photos || []).length;
    counts[p] = n;
    total += n;
  });
  return { counts, total };
}

ensureDirs();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const { id, part } = req.params;
    if (!PARTS.includes(part)) {
      return cb(new Error('无效部位'));
    }
    const dir = getPartDir(id, part);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname) || '.jpg';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${stamp}_${uuidv4().slice(0, 8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持图片文件'));
  }
});

app.get('/api/parts', (_req, res) => {
  res.json({ parts: PARTS });
});

app.get('/api/records', (_req, res) => {
  const data = readRecords();
  const list = data.records.map((r) => {
    const { counts, total } = countPhotos(r.id);
    return { ...r, photoCounts: counts, photoTotal: total };
  });
  res.json({ records: list });
});

app.post('/api/records', (req, res) => {
  const { plate = '', title = '', note = '' } = req.body || {};
  const id = uuidv4();
  const now = new Date().toISOString();
  const record = {
    id,
    plate: String(plate).trim(),
    title: String(title).trim() || (plate ? `${plate} 验车` : '未命名验车'),
    note: String(note).trim(),
    createdAt: now,
    updatedAt: now
  };

  const data = readRecords();
  data.records.unshift(record);
  writeRecords(data);

  fs.mkdirSync(getRecordDir(id), { recursive: true });
  writeMeta(id, {
    parts: Object.fromEntries(PARTS.map((p) => [p, { description: '', photos: [] }]))
  });

  res.status(201).json(record);
});

app.get('/api/records/:id', (req, res) => {
  const data = readRecords();
  const record = data.records.find((r) => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: '记录不存在' });
  const meta = readMeta(record.id);
  const { counts, total } = countPhotos(record.id);
  res.json({ ...record, meta, photoCounts: counts, photoTotal: total, parts: PARTS });
});

app.patch('/api/records/:id', (req, res) => {
  const data = readRecords();
  const idx = data.records.findIndex((r) => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '记录不存在' });
  const { plate, title, note } = req.body || {};
  if (plate !== undefined) data.records[idx].plate = String(plate).trim();
  if (title !== undefined) data.records[idx].title = String(title).trim();
  if (note !== undefined) data.records[idx].note = String(note).trim();
  data.records[idx].updatedAt = new Date().toISOString();
  writeRecords(data);
  res.json(data.records[idx]);
});

app.delete('/api/records/:id', (req, res) => {
  const data = readRecords();
  const idx = data.records.findIndex((r) => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '记录不存在' });
  data.records.splice(idx, 1);
  writeRecords(data);
  const dir = getRecordDir(req.params.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

app.put('/api/records/:id/parts/:part/description', (req, res) => {
  const { id, part } = req.params;
  if (!PARTS.includes(part)) return res.status(400).json({ error: '无效部位' });
  const data = readRecords();
  const record = data.records.find((r) => r.id === id);
  if (!record) return res.status(404).json({ error: '记录不存在' });

  const meta = readMeta(id);
  if (!meta.parts[part]) meta.parts[part] = { description: '', photos: [] };
  meta.parts[part].description = String(req.body?.description || '');
  writeMeta(id, meta);

  record.updatedAt = new Date().toISOString();
  writeRecords(data);
  res.json(meta.parts[part]);
});

app.post('/api/records/:id/parts/:part/photos', upload.array('photos', 20), (req, res) => {
  const { id, part } = req.params;
  if (!PARTS.includes(part)) return res.status(400).json({ error: '无效部位' });
  const data = readRecords();
  const record = data.records.find((r) => r.id === id);
  if (!record) return res.status(404).json({ error: '记录不存在' });
  if (!req.files?.length) return res.status(400).json({ error: '未上传图片' });

  const meta = readMeta(id);
  if (!meta.parts[part]) meta.parts[part] = { description: '', photos: [] };

  const added = req.files.map((f) => ({
    filename: f.filename,
    url: `/uploads/${id}/${encodeURIComponent(part)}/${encodeURIComponent(f.filename)}`,
    createdAt: new Date().toISOString()
  }));
  meta.parts[part].photos.push(...added);
  writeMeta(id, meta);

  record.updatedAt = new Date().toISOString();
  writeRecords(data);
  res.status(201).json({ photos: added, part: meta.parts[part] });
});

app.delete('/api/records/:id/parts/:part/photos/:filename', (req, res) => {
  const { id, part, filename } = req.params;
  if (!PARTS.includes(part)) return res.status(400).json({ error: '无效部位' });
  const data = readRecords();
  const record = data.records.find((r) => r.id === id);
  if (!record) return res.status(404).json({ error: '记录不存在' });

  const meta = readMeta(id);
  const partMeta = meta.parts[part];
  if (!partMeta) return res.status(404).json({ error: '部位不存在' });

  const before = partMeta.photos.length;
  partMeta.photos = partMeta.photos.filter((p) => p.filename !== filename);
  if (partMeta.photos.length === before) return res.status(404).json({ error: '照片不存在' });

  const filePath = path.join(getPartDir(id, part), filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  writeMeta(id, meta);

  record.updatedAt = new Date().toISOString();
  writeRecords(data);
  res.json({ ok: true, part: partMeta });
});

app.get('/api/records/:id/download', (req, res) => {
  const { id } = req.params;
  const data = readRecords();
  const record = data.records.find((r) => r.id === id);
  if (!record) return res.status(404).json({ error: '记录不存在' });

  const dir = getRecordDir(id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '无文件可下载' });

  const safeName = (record.plate || record.title || id).replace(/[\\/:*?"<>|]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName + '_验车照片.zip')}`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: '打包失败' });
  });
  archive.pipe(res);
  archive.directory(dir, false);
  archive.finalize();
});

app.get('/api/records/:id/parts/:part/download', (req, res) => {
  const { id, part } = req.params;
  if (!PARTS.includes(part)) return res.status(400).json({ error: '无效部位' });
  const data = readRecords();
  const record = data.records.find((r) => r.id === id);
  if (!record) return res.status(404).json({ error: '记录不存在' });

  const dir = getPartDir(id, part);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '该部位暂无照片' });

  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (!files.length) return res.status(404).json({ error: '该部位暂无照片' });

  const safePlate = (record.plate || record.title || id).replace(/[\\/:*?"<>|]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(`${safePlate}_${part}.zip`)}`
  );

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: '打包失败' });
  });
  archive.pipe(res);
  archive.directory(dir, part);
  archive.finalize();
});

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

app.get('/api/access-info', async (_req, res) => {
  const ips = getLanIPs();
  const urls = [`http://localhost:${PORT}`, ...ips.map((ip) => `http://${ip}:${PORT}`)];
  const phoneUrl = ips[0] ? `http://${ips[0]}:${PORT}` : urls[0];
  let qrDataUrl = '';
  try {
    const QRCode = require('qrcode');
    qrDataUrl = await QRCode.toDataURL(phoneUrl, {
      margin: 1,
      width: 280,
      color: { dark: '#0f2744', light: '#ffffff' }
    });
  } catch (err) {
    console.warn('二维码生成失败:', err.message);
  }
  res.json({ port: PORT, urls, phoneUrl, qrDataUrl });
});

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIPs();
  console.log(`\n车子验车系统已启动`);
  console.log(`本机访问: http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`手机访问: http://${ip}:${PORT}`));
  console.log(`\n手机安装说明:`);
  console.log(`  网页不能像应用商店直接装 APK，请用浏览器「添加到主屏幕」`);
  console.log(`  iPhone: Safari 打开 → 分享 → 添加到主屏幕`);
  console.log(`  安卓: Chrome 打开 → 右上角 ⋮ → 添加到主屏幕 / 安装应用`);
  console.log(`  不要用微信内置浏览器`);
  console.log(`照片目录: ${UPLOADS_DIR}\n`);
});
