'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4312);
const CONFIG_DIR = process.env.HDP_VOICE_CONFIG_DIR || 'C:\\HDP\\VoiceConfigurator\\data\\configs';
const PROFILE_DIR = process.env.HDP_CONFIG_VOICE_PROFILE_DIR || 'C:\\HDP\\ConfigVoiceDemo\\profiles';
const ENTITLEMENT_DIR = process.env.HDP_CONFIG_VOICE_ENTITLEMENT_DIR || 'C:\\HDP\\ConfigVoiceDemo\\entitlements';
const CONTROL_TOKEN_FILE = process.env.HDP_CONFIG_VOICE_CONTROL_TOKEN_FILE || 'C:\\HDP\\ConfigVoiceDemo\\secrets\\control_token.txt';
const RUNTIME_BASE = process.env.HDP_CONFIG_VOICE_RUNTIME_BASE || 'http://127.0.0.1:3006';
const MAX_CALLS = 3;
const MAX_SECONDS_PER_CALL = 200;

for (const dir of [PROFILE_DIR, ENTITLEMENT_DIR]) fs.mkdirSync(dir, { recursive: true });

const allowedOrigins = new Set([
  'https://www.highestdegreepriorities.com',
  'https://highestdegreepriorities.com',
]);

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function send(req, res, status, payload) {
  const origin = String(req.headers.origin || '');
  if (allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 100000) return reject(new Error('Request too large'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function validConfigId(id) { return /^VA-[A-F0-9]{10}$/.test(String(id || '')); }
function configPath(id) { return validConfigId(id) ? path.join(CONFIG_DIR, `${id}.json`) : null; }
function loadConfig(id) {
  const file = configPath(id);
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function authorized(req, config) {
  const header = String(req.headers.authorization || '');
  const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Boolean(raw && config.manage_token_hash && sha(raw) === config.manage_token_hash);
}

function currentPaidDemo(config) {
  const payments = Array.isArray(config?.commercial?.payments) ? config.commercial.payments : [];
  const allowedOffers = new Set(['voice_demo_activation_v1', 'voice_go_live_v1']);
  return [...payments].reverse().find((p) =>
    allowedOffers.has(String(p.offer || '')) &&
    String(p.payment_status || '').toLowerCase() === 'paid' &&
    Number(p.config_version) === Number(config.version) &&
    String(p.config_hash || '').toLowerCase() === String(config.config_hash || '').toLowerCase()
  ) || null;
}

function profileId(config) {
  const hashHex = String(config.config_hash || '').replace(/^sha256:/, '').toLowerCase();
  return `vc_${String(config.config_id).toLowerCase().replace(/[^a-z0-9]/g, '')}_${hashHex.slice(0, 16)}`;
}

function intakeQuestion(field) {
  const map = {
    name: 'May I get your name?',
    phone: 'What is the best callback number for you?',
    email: 'What email address should we use if follow-up is needed?',
    reason_for_call: 'How can I help you today?',
    address: 'What address is this regarding?',
    urgency: 'How urgent is this for you?',
  };
  return map[field] || `Could you provide ${String(field).replace(/_/g, ' ')}?`;
}

function buildProfile(config) {
  const id = profileId(config);
  const company = String(config.business?.name || 'this business').trim();
  const agent = String(config.agent?.name || 'Ashley').trim();
  const services = Array.isArray(config.business?.services) ? config.business.services : [];
  const objectives = Array.isArray(config.objectives) ? config.objectives : [];
  const collect = Array.isArray(config.collect) ? config.collect : [];
  const hours = String(config.business?.hours || '').trim();
  const tone = String(config.agent?.tone || 'friendly-professional').trim();
  const directions = Array.isArray(config.agent?.direction) ? config.agent.direction : [];

  const guidelines = [
    'Always identify yourself as an AI assistant.',
    'This is a customer-requested demonstration of the configured receptionist.',
    'Keep responses concise, natural, and conversational.',
    `Configured tone: ${tone}.`,
    services.length ? `Business services: ${services.join(', ')}.` : '',
    hours ? `Business hours: ${hours}.` : '',
    objectives.length ? `Configured objectives: ${objectives.join(', ')}.` : '',
    collect.length ? `Information to collect when relevant: ${collect.join(', ')}.` : '',
    directions.includes('outbound_callback') ? 'The configuration includes requested outbound callbacks.' : '',
  ].filter(Boolean);

  return {
    id,
    profile_id: id,
    active: true,
    demoSafe: true,
    configId: config.config_id,
    configVersion: config.version,
    configHash: config.config_hash,
    agentName: agent,
    label: `${company} Configured Voice Demo`,
    companyName: company,
    offer: 'customer-requested AI receptionist demonstration',
    targetCustomer: 'callers',
    script: {
      coldOutboundGreeting: `Hello, this is ${agent}, the AI assistant for ${company}. This is the configured demo you requested. How would you like to test the receptionist today?`,
      inboundGreeting: `Thanks for calling ${company}. This is ${agent}, the AI assistant. How can I help you today?`,
      qualifyingQuestions: collect.map(intakeQuestion),
      appointmentClose: 'In this demonstration I can discuss how appointment handling would work, but I will not create a real appointment.',
      voicemailMessage: `Hello, this is ${agent}, the AI assistant for ${company}. This was the configured demonstration callback you requested.`,
      conversationGuidelines: guidelines,
      forbiddenBehaviours: [
        'Do not claim to be human.',
        'Do not claim an appointment, CRM update, message, transfer, purchase, or other external action actually occurred.',
        'Do not provide unsupported pricing, guarantees, legal, medical, or financial advice.',
        'Do not repeat questions already answered.',
      ],
    },
  };
}

function entitlementPath(config) { return path.join(ENTITLEMENT_DIR, `${config.config_id}.json`); }
function loadEntitlement(config) {
  const file = entitlementPath(config);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function saveEntitlement(config, state) {
  const file = entitlementPath(config);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function ensureProvisioned(config, payment) {
  const id = profileId(config);
  const profile = buildProfile(config);
  const profileFile = path.join(PROFILE_DIR, `${id}.json`);
  fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2), 'utf8');

  let entitlement = loadEntitlement(config);
  if (!entitlement || entitlement.config_hash !== config.config_hash || entitlement.config_version !== config.version) {
    entitlement = {
      config_id: config.config_id,
      config_version: config.version,
      config_hash: config.config_hash,
      profile_id: id,
      checkout_session_id: payment.checkout_session_id || null,
      max_calls: MAX_CALLS,
      max_seconds_per_call: MAX_SECONDS_PER_CALL,
      calls_started: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    saveEntitlement(config, entitlement);
  }
  return entitlement;
}

function runtimeToken() {
  return fs.existsSync(CONTROL_TOKEN_FILE) ? fs.readFileSync(CONTROL_TOKEN_FILE, 'utf8').trim() : '';
}

function callRuntime(profile, phone) {
  return new Promise((resolve, reject) => {
    const base = new URL(RUNTIME_BASE);
    const body = Buffer.from(JSON.stringify({ phone, max_seconds: MAX_SECONDS_PER_CALL }));
    const token = runtimeToken();
    if (!token) return reject(new Error('Runtime control token unavailable'));
    const options = {
      hostname: base.hostname,
      port: base.port || 80,
      path: `/api/customer-demo/${encodeURIComponent(profile)}/call`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Authorization': `Bearer ${token}`,
      },
      timeout: 15000,
    };
    const r = http.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
        if (resp.statusCode >= 200 && resp.statusCode < 300 && data.success) return resolve(data);
        reject(new Error(data.message || `Runtime returned ${resp.statusCode}`));
      });
    });
    r.on('timeout', () => r.destroy(new Error('Runtime timeout')));
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(req, res, 204, {});
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(req, res, 200, { ok: true, product: 'HDP ConfigVoiceDemo Bridge', version: '1.0.0', max_calls: MAX_CALLS, max_seconds_per_call: MAX_SECONDS_PER_CALL });
    }

    let match = url.pathname.match(/^\/api\/configs\/(VA-[A-F0-9]{10})\/demo-entitlement$/);
    if (match && req.method === 'GET') {
      const config = loadConfig(match[1]);
      if (!config) return send(req, res, 404, { error: 'Configuration not found' });
      if (!authorized(req, config)) return send(req, res, 401, { error: 'Manage token required' });
      const payment = currentPaidDemo(config);
      if (!payment) return send(req, res, 200, { entitled: false, reason: 'No paid demo activation for the current configuration hash/version.' });
      const entitlement = ensureProvisioned(config, payment);
      return send(req, res, 200, {
        entitled: true,
        profile_ready: true,
        calls_started: entitlement.calls_started,
        calls_remaining: Math.max(0, entitlement.max_calls - entitlement.calls_started),
        max_calls: entitlement.max_calls,
        max_seconds_per_call: entitlement.max_seconds_per_call,
        config_hash: config.config_hash,
      });
    }

    match = url.pathname.match(/^\/api\/configs\/(VA-[A-F0-9]{10})\/call-my-agent$/);
    if (match && req.method === 'POST') {
      const config = loadConfig(match[1]);
      if (!config) return send(req, res, 404, { error: 'Configuration not found' });
      if (!authorized(req, config)) return send(req, res, 401, { error: 'Manage token required' });
      const payment = currentPaidDemo(config);
      if (!payment) return send(req, res, 403, { error: 'A paid Demo Activation for this exact configuration is required.' });
      const body = await readBody(req);
      if (body.consent_to_callback !== true) return send(req, res, 400, { error: 'Explicit callback consent is required.' });
      const phone = String(body.phone || '').trim();
      if (!/^\+1\d{10}$/.test(phone)) return send(req, res, 400, { error: 'Enter a US/Canada number in +1XXXXXXXXXX format.' });
      const entitlement = ensureProvisioned(config, payment);
      if (entitlement.calls_started >= entitlement.max_calls) return send(req, res, 409, { error: 'Demo call allowance has been used.', calls_remaining: 0 });

      const result = await callRuntime(entitlement.profile_id, phone);
      entitlement.calls_started += 1;
      entitlement.last_call_at = new Date().toISOString();
      entitlement.updated_at = entitlement.last_call_at;
      saveEntitlement(config, entitlement);
      return send(req, res, 200, {
        ok: true,
        message: 'Your configured agent is calling now.',
        calls_remaining: Math.max(0, entitlement.max_calls - entitlement.calls_started),
        max_seconds_this_call: entitlement.max_seconds_per_call,
        call_reference: result.call_sid || null,
      });
    }

    return send(req, res, 404, { error: 'Not found' });
  } catch (error) {
    return send(req, res, 500, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HDP ConfigVoiceDemo Bridge listening on 127.0.0.1:${PORT}`);
});
