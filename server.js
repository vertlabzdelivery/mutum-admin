const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 4173;
const DEFAULT_API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Payload muito grande'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeApiBaseUrl(value) {
  return (value || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

function handleProxy(req, res) {
  readBody(req)
    .then((body) => {
      const targetBaseUrl = normalizeApiBaseUrl(req.headers['x-target-base-url']);
      const targetPath = req.url.replace(/^\/proxy/, '') || '/';
      const targetUrl = new URL(targetBaseUrl + targetPath);
      const transport = targetUrl.protocol === 'https:' ? https : http;
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers['content-length'];
      delete headers['x-target-base-url'];

      const proxyReq = transport.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
        const responseHeaders = { ...proxyRes.headers };
        responseHeaders['access-control-allow-origin'] = '*';
        responseHeaders['access-control-allow-headers'] = '*';
        responseHeaders['access-control-allow-methods'] = '*';
        res.writeHead(proxyRes.statusCode || 500, responseHeaders);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (error) => {
        sendJson(res, 502, { message: 'Falha ao conectar com a API alvo.', targetBaseUrl, error: error.message });
      });
      if (body && !['GET', 'HEAD'].includes(req.method || 'GET')) proxyReq.write(body);
      proxyReq.end();
    })
    .catch((error) => sendJson(res, 500, { message: 'Erro no proxy.', error: error.message }));
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Arquivo não encontrado');
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.html') {
      const injected = String(content).replace('</head>', `<script>window.__API_BASE_URL__ = ${JSON.stringify(DEFAULT_API_BASE_URL)};</script></head>`);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[extension] });
      res.end(injected);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extension] || 'application/octet-stream' });
    res.end(content);
  });
}

function requestHandler(req, res) {
  if (!req.url) return sendJson(res, 400, { message: 'URL inválida' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    return res.end();
  }
  if (req.url === '/health') {
    return sendJson(res, 200, { ok: true, panel: 'delivery-admin-panel', defaultApiBaseUrl: DEFAULT_API_BASE_URL });
  }
  if (req.url.startsWith('/proxy/')) return handleProxy(req, res);

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Acesso negado');
  }
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) return serveFile(filePath, res);
    return serveFile(path.join(PUBLIC_DIR, 'index.html'), res);
  });
}

const server = http.createServer(requestHandler);
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Painel admin em http://localhost:${PORT}`);
  });
}
module.exports = server;
