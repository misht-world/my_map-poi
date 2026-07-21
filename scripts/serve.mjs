// Zero-dep статический сервер для локального просмотра карты (npm run dev).
// Отдаёт корень репозитория, чтобы web/index.html мог тянуть и config/scoring.json,
// и data/normalized/*.geojson. Никаких зависимостей — целиком бесплатно и без сборки.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, extname, normalize } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    // Раздаём как GitHub Pages: сначала web/<path> (index.html, europe.html, *-meta.json),
    // затем корень (config/, data/). Так относительные пути в страницах сходятся везде.
    const webPath = normalize(resolve(ROOT, 'web', '.' + urlPath));
    const rootPath = normalize(resolve(ROOT, '.' + urlPath));
    if (!webPath.startsWith(resolve(ROOT, 'web')) && !rootPath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let filePath = webPath;
    let body = await readFile(webPath).catch(() => null);
    if (body === null) { filePath = rootPath; body = await readFile(rootPath); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    console.log(`my_map-poi dev: http://localhost:${PORT}/`);
  });
}
