const http = require('http');
const https = require('https');

const DEFAULT_API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

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

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    return res.status(204).end();
  }

  try {
    const targetBaseUrl = (req.headers['x-target-base-url'] || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    const pathParts = Array.isArray(req.query.path) ? req.query.path : [req.query.path].filter(Boolean);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query || {})) {
      if (key === 'path') continue;
      if (Array.isArray(value)) value.forEach((v) => query.append(key, String(v)));
      else if (value !== undefined) query.append(key, String(value));
    }
    const targetUrl = `${targetBaseUrl}/${pathParts.join('/')}${query.toString() ? `?${query.toString()}` : ''}`;
    const body = await readBody(req);
    const url = new URL(targetUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['x-target-base-url'];
    headers.accept = headers.accept || 'application/json';

    const proxyReq = transport.request(url, { method: req.method, headers }, (proxyRes) => {
      Object.entries(proxyRes.headers || {}).forEach(([key, value]) => {
        if (value !== undefined) res.setHeader(key, value);
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.statusCode = proxyRes.statusCode || 500;
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (error) => {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ message: 'Falha ao conectar com a API alvo.', targetBaseUrl, error: error.message }));
    });

    if (body && !['GET', 'HEAD'].includes(req.method || 'GET')) proxyReq.write(body);
    proxyReq.end();
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ message: 'Erro no proxy.', error: error.message }));
  }
};
