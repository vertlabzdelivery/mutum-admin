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
    const rawPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
    const cleanPath = String(rawPath || '').trim();
    if (!cleanPath) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ message: 'Parâmetro path é obrigatório.' }));
    }
    const targetUrl = `${targetBaseUrl}${cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`}`;
    const body = await readBody(req);
    const url = new URL(targetUrl);
    const client = url.protocol === 'https:' ? https : http;

    const upstream = client.request(url, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        authorization: req.headers.authorization || '',
      },
    }, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const buffer = Buffer.concat(chunks);
        res.statusCode = upstreamRes.statusCode || 500;
        const contentType = upstreamRes.headers['content-type'] || 'application/json; charset=utf-8';
        res.setHeader('Content-Type', contentType);
        res.end(buffer);
      });
    });

    upstream.on('error', (error) => {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ message: 'Falha ao comunicar com a API.', error: error.message }));
    });

    if (body) upstream.write(body);
    upstream.end();
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ message: 'Erro no proxy.', error: error.message }));
  }
};
