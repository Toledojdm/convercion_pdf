// server.js
const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');

const app = express();

const PORT = process.env.PORT || 8080; // Cloud Run usa 8080
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(os.tmpdir(), 'uploads');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '26214400', 10); // 25 MB por defecto
const CONVERSION_TIMEOUT_MS = parseInt(process.env.CONVERSION_TIMEOUT_MS || '180000', 10); // 180s
const MAX_CONCURRENCY = 1;

// Asegura directorio de trabajo
if (!fsSync.existsSync(UPLOADS_DIR)) {
  fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Storage de multer con nombres únicos
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '').slice(0, 10);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  // fileFilter: (req, file, cb) => {
  //   // Opcional: validar tipos permitidos
  //   cb(null, true);
  // },
});

// Limitador de concurrencia simple
class Limiter {
  constructor(n) {
    this.n = Math.max(1, n);
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.n) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
const limiter = new Limiter(MAX_CONCURRENCY);

// Healthcheck
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Conversión a PDF usando LibreOffice directamente
app.post('/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se ha subido ningún archivo.' });

  const inputPath = req.file.path;
  const outDir = path.dirname(inputPath);
  const expectedPdf = path.join(outDir, `${path.parse(inputPath).name}.pdf`);
  const downloadName = `${path.parse(req.file.originalname).name}.pdf`;

  let execa;
  try {
    // execa es ESM; import dinámico desde CJS
    ({ execa } = await import('execa'));
  } catch (e) {
    console.error('No se pudo cargar execa:', e);
    try { await fs.unlink(inputPath); } catch {}
    return res.status(500).json({ error: 'Dependencia de ejecución no disponible.' });
  }

  try {
    await limiter.run(async () => {
      // Llamamos a LibreOffice en modo headless
      await execa(
        'soffice',
        [
          '--headless',
          '--nologo',
          '--nodefault',
          '--nofirststartwizard',
          '--convert-to',
          'pdf',
          '--outdir',
          outDir,
          inputPath,
        ],
        { timeout: CONVERSION_TIMEOUT_MS }
      );
    });

    if (!fsSync.existsSync(expectedPdf)) {
      // A veces LibreOffice puede fallar silenciosamente
      throw new Error('No se generó el PDF de salida.');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.download(expectedPdf, downloadName, async (err) => {
      try { await fs.unlink(inputPath); } catch {}
      try { await fs.unlink(expectedPdf); } catch {}
      if (err) console.error('Error al enviar archivo:', err);
    });
  } catch (error) {
    console.error('Error en conversión:', error);
    try { await fs.unlink(inputPath); } catch {}
    try { await fs.unlink(expectedPdf); } catch {}
    res.status(500).json({ error: 'La conversión falló.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servicio de conversión escuchando en el puerto ${PORT}`);
  console.log(`Subidas en: ${UPLOADS_DIR} (Cloud Run: /tmp) | Concurrencia: ${MAX_CONCURRENCY}`);
});
