// Run with: node --env-file-if-exists=.env scripts/serve-local.js
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');

const host = '127.0.0.1';
const port = Number(process.env.LUNAR_PORT || 8766);
const webRoot = path.resolve(__dirname, '../web');
const key = (process.env.OPENAI_API_KEY || process.env.OpenAI_API || '').trim();
const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg'
};
const actions = ['explain', 'earthset', 'mast', 'delay', 'brief'];

function writeJson(response, code, value) {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 12000) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function callOpenAI(endpoint, payload) {
  if (!key) throw Object.assign(new Error('OpenAI key is missing.'), { status: 503 });
  const result = await fetch('https://api.openai.com/v1/' + endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35000)
  });
  if (!result.ok) {
    // Keep provider diagnostics on the server, without logging response or credential data.
    console.warn('OpenAI request failed', endpoint, result.status, result.headers.get('x-request-id') || '');
    throw Object.assign(new Error('OpenAI returned ' + result.status), { status: result.status === 429 ? 429 : 502 });
  }
  return result;
}

async function ask(request, response) {
  let data;
  try { data = await readJson(request); }
  catch { return writeJson(response, 400, { error: 'Send a valid mission question.' }); }
  const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';
  if (!prompt || prompt.length > 400 || typeof data?.context !== 'string' || data.context.length > 4000) {
    return writeJson(response, 400, { error: 'Use a question between 1 and 400 characters.' });
  }
  const result = await callOpenAI('responses', {
    model, store: false, max_output_tokens: 650,
    ...(model.startsWith('gpt-5') ? { reasoning: { effort: 'low' } } : {}),
    instructions: [
      'You are the copilot for a NASA-data lunar landing simulator. Answer only about this simulation.',
      'Use the supplied snapshot for numerical facts and explicitly say when evidence is missing.',
      'The app computes all science. Do not guess, derive new numerical results, or claim that geometric contact guarantees a radio link.',
      'Return explain for questions about the current scene or unsupported requests. For an explicit request to show an Earthset, use earthset. Use mast for a 10 m preview, delay for a 90-day shortlist with a zero-hour battery limit, and brief for a saved comparison summary.',
      'If the visitor requests a different numeric control than those presets, use explain and guide them to the manual controls.',
      'The action will only run after the visitor clicks its button. Describe what they can open using future tense. Give at most two short sentences and adapt them to the audience requested.'
    ].join(' '),
    input: JSON.stringify({ snapshot: data.context, question: prompt }),
    text: { format: { type: 'json_schema', name: 'lunar_copilot', strict: true, schema: {
      type: 'object', additionalProperties: false,
      properties: { answer: { type: 'string' }, action: { type: 'string', enum: actions } },
      required: ['answer', 'action']
    } } }
  });
  const payload = await result.json();
  const message = payload.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text');
  if (!message) return writeJson(response, 502, { error: 'No answer was returned. Try a guided prompt.' });
  const answer = JSON.parse(message.text);
  if (typeof answer.answer !== 'string' || !actions.includes(answer.action)) {
    return writeJson(response, 502, { error: 'The answer did not match a mission action.' });
  }
  writeJson(response, 200, { answer: answer.answer.slice(0, 1000), action: answer.action });
}

let activeRequests = 0;
const server = http.createServer(async (request, response) => {
  // Binding locally and checking Host/Origin prevents another website from spending the local key.
  if (![host + ':' + port, 'localhost:' + port].includes(request.headers.host)) {
    return writeJson(response, 403, { error: 'This preview is available on localhost.' });
  }
  const url = new URL(request.url, 'http://' + request.headers.host);
  if (url.pathname.startsWith('/api/')) {
    const allowedOrigin = 'http://' + request.headers.host;
    if (request.headers.origin && request.headers.origin !== allowedOrigin)
      return writeJson(response, 403, { error: 'Cross-origin requests are blocked.' });
    if (url.pathname === '/api/copilot/status' && request.method === 'GET') return writeJson(response, 200, { configured: Boolean(key) });
    if (request.method !== 'POST' || url.pathname !== '/api/copilot/ask')
      return writeJson(response, 404, { error: 'Unknown copilot route.' });
    if (!request.headers['content-type']?.startsWith('application/json'))
      return writeJson(response, 415, { error: 'Use a JSON request.' });
    if (activeRequests >= 2) return writeJson(response, 429, { error: 'The copilot is busy. Try again shortly.' });
    activeRequests++;
    try { await ask(request, response); }
    catch (error) {
      writeJson(response, error.status || 502, {
        error: error.status === 503 ? 'Live OpenAI access is not configured.' : 'OpenAI is unavailable. Guided prompts still work.'
      });
    } finally { activeRequests--; }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return writeJson(response, 405, { error: 'Method not allowed.' });
  try {
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (relative.includes('\0') || relative.split(/[\\/]/).some(part => part.startsWith('.'))) return writeJson(response, 403, { error: 'Forbidden.' });
    const file = path.resolve(webRoot, '.' + relative);
    if (!file.startsWith(webRoot + path.sep)) return writeJson(response, 403, { error: 'Forbidden.' });
    const content = await fs.readFile(file);
    response.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-store'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    writeJson(response, 404, { error: 'File not found.' });
  }
});

server.listen(port, host, () => {
  console.log('Lunar Maps: http://' + host + ':' + port + '/');
  console.log('OpenAI configuration: ' + (key ? 'present' : 'missing. Guided prompts available.'));
});
