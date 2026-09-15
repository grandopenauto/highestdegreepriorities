'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4311);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const CONFIG_DIR = path.join(DATA, 'configs');
const EVENTS = path.join(DATA, 'events.jsonl');
const PUBLIC = path.join(ROOT, 'public');
const REVIEW = process.env.VOICE_CONFIG_REVIEW_MODE !== '0';
const EMAIL_LIVE = process.env.VOICE_CONFIG_EMAIL_LIVE === '1';
const PUBLIC_URL = process.env.VOICE_CONFIG_PUBLIC_URL || 'https://www.highestdegreepriorities.com/voice-configurator/';
const EMAIL_PYTHON = process.env.VOICE_CONFIG_EMAIL_PYTHON || 'C:\\HDP\\EmailAgent\\venv\\Scripts\\python.exe';
const EMAIL_HELPER = path.join(ROOT, 'integrations', 'send_gmail.py');

const checkoutUrls = {
  demo_activation: process.env.VOICE_CONFIG_DEMO_PAYMENT_URL || '',
  go_live: process.env.VOICE_CONFIG_GO_LIVE_PAYMENT_URL || '',
  managed_setup: process.env.VOICE_CONFIG_MANAGED_PAYMENT_URL || '',
};

const allowedOrigins = new Set([
  'https://www.highestdegreepriorities.com',
  'https://highestdegreepriorities.com',
]);

const offers = {
  demo_activation: { code: 'voice_demo_activation_v1', amount: 20, label: 'Activate Demo', next: 'DEMO_PAID' },
  go_live: { code: 'voice_go_live_v1', amount: 49, label: 'Go Live', next: 'GO_LIVE_PAID' },
  managed_setup: { code: 'voice_managed_setup_v1', amount: 500, label: 'Managed Implementation Setup', next: 'MANAGED_SETUP_PAID' },
};

fs.mkdirSync(CONFIG_DIR, { recursive: true });

const now = () => new Date().toISOString();
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = () => crypto.randomBytes(24).toString('hex');
const configId = () => `VA-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

function cors(req, res) {
  const origin = String(req.headers.origin || '');
  if (allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
}

function send(req, res, status, payload, headers = {}) {
  cors(req, res);
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 200000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function configPath(id) {
  if (!/^VA-[A-F0-9]{10}$/.test(id)) throw new Error('Invalid config_id');
  return path.join(CONFIG_DIR, `${id}.json`);
}

function load(id) {
  const file = configPath(id);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function save(config) {
  fs.writeFileSync(configPath(config.config_id), JSON.stringify(config, null, 2));
  return config;
}

function event(type, config, extra = {}) {
  fs.appendFileSync(EVENTS, JSON.stringify({
    at: now(),
    type,
    config_id: config?.config_id || null,
    version: config?.version || null,
    ...extra,
  }) + '\n');
}

function uniqueList(value) {
  return Array.isArray(value) ? [...new Set(value.map((x) => String(x).trim()).filter(Boolean))] : [];
}

function canonical(config) {
  return JSON.stringify({
    schema: config.schema,
    config_id: config.config_id,
    version: config.version,
    customer: { name: config.customer.name, email: config.customer.email },
    agent: config.agent,
    business: config.business,
    objectives: config.objectives,
    collect: config.collect,
    escalation: config.escalation,
    integrations_requested: config.integrations_requested,
    managed_features: config.managed_features,
    commercial: {
      selected_path: config.commercial.selected_path,
      plan: config.commercial.plan,
    },
  });
}

function rehash(config) {
  config.config_hash = `sha256:${sha(canonical(config))}`;
  return config;
}

function authorized(req, config) {
  const header = String(req.headers.authorization || '');
  const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Boolean(raw) && sha(raw) === config.manage_token_hash;
}

function publicConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  delete copy.manage_token_hash;
  delete copy.verification_token_hash;
  delete copy.verification_expires_at;
  return copy;
}

function applyPatch(config, body) {
  config.customer.name = String(body.customer?.name ?? config.customer.name ?? '').trim().slice(0, 120);
  config.customer.email = String(body.customer?.email ?? config.customer.email ?? '').trim().toLowerCase().slice(0, 180);
  config.agent.name = String(body.agent?.name ?? config.agent.name ?? 'Ashley').trim().slice(0, 80) || 'Ashley';
  config.agent.role = String(body.agent?.role ?? config.agent.role ?? 'AI Receptionist').trim().slice(0, 100) || 'AI Receptionist';
  config.agent.direction = uniqueList(body.agent?.direction ?? config.agent.direction);
  config.agent.tone = String(body.agent?.tone ?? config.agent.tone ?? 'friendly-professional').trim().slice(0, 80);
  config.business.name = String(body.business?.name ?? config.business.name ?? '').trim().slice(0, 140);
  config.business.hours = String(body.business?.hours ?? config.business.hours ?? '').trim().slice(0, 240);
  config.business.services = uniqueList(body.business?.services ?? config.business.services).slice(0, 25);
  config.objectives = uniqueList(body.objectives ?? config.objectives).slice(0, 25);
  config.collect = uniqueList(body.collect ?? config.collect).slice(0, 25);
  config.escalation = {
    human_transfer: Boolean(body.escalation?.human_transfer ?? config.escalation.human_transfer),
    urgent_calls: Boolean(body.escalation?.urgent_calls ?? config.escalation.urgent_calls),
    destination: String(body.escalation?.destination ?? config.escalation.destination ?? '').trim().slice(0, 160),
  };
  config.integrations_requested = uniqueList(body.integrations_requested ?? config.integrations_requested).slice(0, 25);
  config.managed_features = uniqueList(body.managed_features ?? config.managed_features).slice(0, 25);
  config.commercial.selected_path = String(body.commercial?.selected_path ?? config.commercial.selected_path ?? '').slice(0, 80);
  config.commercial.plan = String(body.commercial?.plan ?? config.commercial.plan ?? 'basic_receptionist').slice(0, 80);
  config.updated_at = now();
  return rehash(config);
}

function fresh(body = {}) {
  const manageToken = token();
  const config = {
    schema: 'hdp.voice-agent-spec/v1',
    config_id: configId(),
    config_hash: '',
    version: 1,
    status: 'DRAFT',
    created_at: now(),
    updated_at: now(),
    customer: { name: '', email: '', email_verified: false, verified_at: null },
    agent: { name: 'Ashley', role: 'AI Receptionist', direction: ['inbound'], tone: 'friendly-professional' },
    business: { name: '', hours: '', services: [] },
    objectives: ['answer inbound calls', 'capture leads'],
    collect: ['name', 'phone', 'reason_for_call'],
    escalation: { human_transfer: true, urgent_calls: true, destination: '' },
    integrations_requested: [],
    managed_features: [],
    commercial: { selected_path: '', plan: 'basic_receptionist', checkout_intents: [], payments: [] },
    lifecycle: [{ at: now(), status: 'DRAFT' }],
    manage_token_hash: sha(manageToken),
  };
  applyPatch(config, body);
  save(config);
  event('config_created', config);
  return { config, manageToken };
}

function setStatus(config, status, detail = '') {
  if (config.status !== status) {
    config.status = status;
    config.lifecycle.push({ at: now(), status, detail });
    config.updated_at = now();
    save(config);
    event('status_changed', config, { status, detail });
  }
}

function validEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || ''));
}

function receiptText(config) {
  const list = (x) => Array.isArray(x) && x.length ? x.join(', ') : 'None';
  const direction = list((config.agent?.direction || []).map((x) => x === 'inbound' ? 'Inbound' : x === 'outbound_callback' ? 'Requested outbound callbacks' : x));
  return [
    'HDP Voice Agent Configuration Receipt',
    '=====================================',
    '',
    `Configuration Hash: ${config.config_hash}`,
    `Saved: ${config.updated_at}`,
    '',
    'Customer', '--------',
    `Name: ${config.customer?.name || ''}`,
    `Email: ${config.customer?.email || ''}`,
    '',
    'Business', '--------',
    `Business name: ${config.business?.name || ''}`,
    `Business hours: ${config.business?.hours || ''}`,
    `Services: ${list(config.business?.services)}`,
    '',
    'Voice Agent', '-----------',
    `Agent name: ${config.agent?.name || ''}`,
    `Role: ${config.agent?.role || ''}`,
    `Direction: ${direction}`,
    `Tone: ${config.agent?.tone || ''}`,
    '',
    'Objectives', '----------',
    ...(config.objectives?.length ? config.objectives.map((x) => `- ${x}`) : ['- None']),
    '',
    'Information to Collect', '----------------------',
    ...(config.collect?.length ? config.collect.map((x) => `- ${x}`) : ['- None']),
    '',
    'Escalation', '----------',
    `Human transfer: ${config.escalation?.human_transfer ? 'Yes' : 'No'}`,
    `Urgent calls: ${config.escalation?.urgent_calls ? 'Yes' : 'No'}`,
    `Destination: ${config.escalation?.destination || 'Not specified'}`,
    '',
    'Advanced / Managed Features', '---------------------------',
    ...(config.managed_features?.length ? config.managed_features.map((x) => `- ${x}`) : ['- None']),
    '',
    'Commercial', '----------',
    `Plan: ${config.commercial?.plan || ''}`,
    `Status: ${config.status || ''}`,
    '',
    'QA Reference', '------------',
    'This receipt is a human-readable snapshot of the saved configuration associated with the hash above.',
    'HDP preserves the authoritative machine-readable configuration internally for verification, fulfillment, and QA.',
    'If the configuration is changed later, a new hash is issued for the new saved configuration.',
    '',
  ].join('\n');
}

function sendEmail(to, subject, text) {
  const result = cp.spawnSync(EMAIL_PYTHON, [EMAIL_HELPER], {
    input: JSON.stringify({ to, subject, body: text, sender_key: 'outreach-main' }),
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Gmail send failed').trim());
  try { return JSON.parse((result.stdout || '{}').trim()); }
  catch { return {}; }
}

function checkoutUrl(key, config) {
  const base = checkoutUrls[key];
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('client_reference_id', config.config_id);
  if (config.customer?.email) url.searchParams.set('prefilled_email', config.customer.email);
  return url.toString();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      cors(req, res);
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(req, res, 200, {
        ok: true,
        product: 'HDP Voice Configurator',
        version: '2.0.0',
        review_mode: REVIEW,
        payment_live: Object.values(checkoutUrls).filter(Boolean).length,
        email_live: EMAIL_LIVE,
        provisioning_live: false,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/offers') {
      return send(req, res, 200, {
        offers,
        payment_available: {
          demo_activation: Boolean(checkoutUrls.demo_activation),
          go_live: Boolean(checkoutUrls.go_live),
          managed_setup: Boolean(checkoutUrls.managed_setup),
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/configs') {
      const created = fresh(await readBody(req));
      return send(req, res, 201, { config: publicConfig(created.config), manage_token: created.manageToken });
    }

    let match = url.pathname.match(/^\/api\/configs\/(VA-[A-F0-9]{10})$/);
    if (match && req.method === 'GET') {
      const config = load(match[1]);
      if (!config) return send(req, res, 404, { error: 'Not found' });
      if (!authorized(req, config)) return send(req, res, 401, { error: 'Manage token required' });
      return send(req, res, 200, { config: publicConfig(config) });
    }

    if (match && req.method === 'PATCH') {
      const config = load(match[1]);
      if (!config) return send(req, res, 404, { error: 'Not found' });
      if (!authorized(req, config)) return send(req, res, 401, { error: 'Manage token required' });
      config.version += 1;
      applyPatch(config, await readBody(req));
      if (config.customer.email_verified) {
        config.customer.email_verified = false;
        config.customer.verified_at = null;
        setStatus(config, 'CONFIGURED', 'Configuration changed; email verification must be reconfirmed.');
      }
      save(config);
      event('config_updated', config);
      return send(req, res, 200, { config: publicConfig(config) });
    }

    match = url.pathname.match(/^\/api\/configs\/(VA-[A-F0-9]{10})\/request-verification$/);
    if (match && req.method === 'POST') {
      const config = load(match[1]);
      if (!config) return send(req, res, 404, { error: 'Not found' });
      if (!authorized(req, config)) return send(req, res, 401, { error: 'Manage token required' });
      if (!config.customer.name || !validEmail(config.customer.email)) {
        return send(req, res, 400, { error: 'A name and working-format email are required.' });
      }

      const verificationToken = token();
      config.verification_token_hash = sha(verificationToken);
      config.verification_expires_at = new Date(Date.now() + 1800000).toISOString();
      config.customer.email_verified = false;
      config.customer.verified_at = null;
      setStatus(config, 'EMAIL_PENDING', 'Verification requested.');
      save(config);
      event('verification_requested', config);

      const verifyLink = `${PUBLIC_URL}?verify_config=${encodeURIComponent(config.config_id)}&verify_token=${encodeURIComponent(verificationToken)}`;
      if (EMAIL_LIVE && !REVIEW) {
        const message = [
          `Hi ${config.customer.name},`, '',
          'Verify your HDP Voice Agent configuration:', '',
          verifyLink, '',
          'Configuration hash:', config.config_hash, '',
          'This link expires in 30 minutes. If you did not create this configuration, you can ignore this email.', '',
          'Highest Degree Priorities',
        ].join('\n');
        sendEmail(config.customer.email, 'Verify your HDP Voice Agent configuration', message);
        event('verification_email_sent', config, { to: config.customer.email });
        return send(req, res, 200, { ok: true, status: config.status, email: config.customer.email, delivery_mode: 'EMAIL_SENT' });
      }

      const output = { ok: true, status: config.status, email: config.customer.email, delivery_mode: REVIEW ? 'REVIEW_LINK_ONLY' : 'EMAIL_ADAPTER_HOLD' };
      if (REVIEW) output.review_verification_token = verificationToken;
      return send(req, res, 200, output);
    }

    if (req.method === 'POST' && url.pathname === '/api/verify') {
      const input = await readBody(req);
      const config = load(String(input.config_id || ''));
      if (!config) return send(req, res, 404, { error: 'Not found' });
      if (!config.verification_token_hash || sha(String(input.token || '')) !== config.verification_token_hash) {
        return send(req, res, 400, { error: 'Invalid verification token' });
      }
      if (Date.parse(config.verification_expires_at) < Date.now()) {
        return send(req, res, 400, { error: 'Verification token expired' });
      }

      config.customer.email_verified = true;
      config.customer.verified_at = now();
      delete config.verification_token_hash;
      delete config.verification_expires_at;
      const newManageToken = token();
      config.manage_token_hash = sha(newManageToken);
      setStatus(config, 'EMAIL_VERIFIED', 'Email verified.');
      save(config);
      event('email_verified', config);

      let receiptEmailSent = false;
      if (EMAIL_LIVE && !REVIEW) {
        try {
          sendEmail(config.customer.email, 'Your HDP Voice Agent configuration receipt', receiptText(config));
          receiptEmailSent = true;
          event('configuration_receipt_emailed', config, { to: config.customer.email });
        } catch (error) {
          event('configuration_receipt_email_failed', config, { error: error.message });
        }
      }

      return send(req, res, 200, {
        ok: true,
        config: publicConfig(config),
        manage_token: newManageToken,
        receipt_email_sent: receiptEmailSent,
      });
    }

    match = url.pathname.match(/^\/api\/configs\/(VA-[A-F0-9]{10})\/checkout-intent$/);
    if (match && req.method === 'POST') {
      const config = load(match[1]);
      if (!config) return send(req, res, 404, { error: 'Not found' });
      if (!authorized(req, config)) return send(req, res, 401, { error: 'Manage token required' });
      if (!config.customer.email_verified) return send(req, res, 409, { error: 'Verify email before checkout.' });

      const input = await readBody(req);
      const key = String(input.offer || '');
      const offer = offers[key];
      if (!offer) return send(req, res, 400, { error: 'Unknown offer' });

      const checkout = checkoutUrl(key, config);
      const intent = {
        intent_id: `VCI-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
        created_at: now(),
        offer: offer.code,
        amount_usd: offer.amount,
        config_id: config.config_id,
        config_hash: config.config_hash,
        config_version: config.version,
        status: checkout ? 'CHECKOUT_READY' : 'CHECKOUT_PREPARED_HOLD',
      };

      config.commercial.selected_path = key;
      config.commercial.checkout_intents.push(intent);
      setStatus(config, 'CHECKOUT_STARTED', offer.code);
      save(config);
      event('checkout_prepared', config, { intent_id: intent.intent_id, offer: intent.offer, amount_usd: intent.amount_usd, payment_live: Boolean(checkout) });

      return send(req, res, 200, {
        ok: true,
        intent,
        payment_live: Boolean(checkout),
        checkout_url: checkout,
        message: checkout ? 'Checkout is ready.' : 'Payment adapter is not connected yet; your configuration remains saved.',
      });
    }

    if (req.method === 'GET') {
      let requested = url.pathname === '/' ? '/index.html' : url.pathname;
      requested = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(PUBLIC, requested);
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
        cors(req, res);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
        return fs.createReadStream(file).pipe(res);
      }
    }

    return send(req, res, 404, { error: 'Not found' });
  } catch (error) {
    return send(req, res, 500, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HDP Voice Configurator v2 listening on 127.0.0.1:${PORT}`);
});
