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
const FULFILLMENT = path.join(DATA, 'fulfillment.jsonl');
const PUBLIC = path.join(ROOT, 'public');
const REVIEW = process.env.VOICE_CONFIG_REVIEW_MODE !== '0';
const EMAIL_LIVE = process.env.VOICE_CONFIG_EMAIL_LIVE === '1';
const PUBLIC_URL = process.env.VOICE_CONFIG_PUBLIC_URL || 'https://www.highestdegreepriorities.com/voice-configurator/';
const EMAIL_PYTHON = process.env.VOICE_CONFIG_EMAIL_PYTHON || 'C:\\HDP\\EmailAgent\\venv\\Scripts\\python.exe';
const EMAIL_HELPER = path.join(ROOT, 'integrations', 'send_gmail.py');
const STRIPE_WEBHOOK_SECRET_FILE = process.env.VOICE_CONFIG_STRIPE_WEBHOOK_SECRET_FILE || path.join(ROOT, 'secrets', 'stripe_webhook_secret.txt');
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

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
  demo_activation: {
    code: 'voice_demo_activation_v1',
    stripe_offer: 'voice_demo_activation',
    amount: 20,
    label: 'Activate Demo',
    next: 'DEMO_PAID',
    fulfillment: 'DEMO_PROVISIONING_PENDING',
  },
  go_live: {
    code: 'voice_go_live_v1',
    stripe_offer: 'voice_go_live',
    amount: 49,
    label: 'Go Live',
    next: 'GO_LIVE_PAID',
    fulfillment: 'GO_LIVE_PROVISIONING_PENDING',
  },
  managed_setup: {
    code: 'voice_managed_setup_v1',
    stripe_offer: 'voice_managed_setup',
    amount: 500,
    label: 'Managed Implementation Setup',
    next: 'MANAGED_SETUP_PAID',
    fulfillment: 'MANAGED_IMPLEMENTATION_QUEUE',
  },
};

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(path.dirname(STRIPE_WEBHOOK_SECRET_FILE), { recursive: true });

const now = () => new Date().toISOString();
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = () => crypto.randomBytes(24).toString('hex');
const configId = () => `VA-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

function stripeWebhookSecret() {
  const fromEnv = String(process.env.VOICE_CONFIG_STRIPE_WEBHOOK_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(STRIPE_WEBHOOK_SECRET_FILE)) return fs.readFileSync(STRIPE_WEBHOOK_SECRET_FILE, 'utf8').trim();
  } catch (_) {}
  return '';
}

function paymentReady() {
  return !REVIEW && Boolean(stripeWebhookSecret()) && Object.values(checkoutUrls).every(Boolean);
}

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

function readRawBody(req, limit = 1000000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req) {
  const raw = await readRawBody(req, 200000);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch (_) { throw new Error('Invalid JSON'); }
}

function configPath(id) {
  if (!/^VA-[A-F0-9]{10}$/.test(id)) throw new Error('Invalid config_id');
  return path.join(CONFIG_DIR, `${id}.json`);
}

function load(id) {
  const file = configPath(id);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function ensureCommercial(config) {
  config.commercial = config.commercial || {};
  config.commercial.checkout_intents = Array.isArray(config.commercial.checkout_intents) ? config.commercial.checkout_intents : [];
  config.commercial.payments = Array.isArray(config.commercial.payments) ? config.commercial.payments : [];
  return config;
}

function save(config) {
  ensureCommercial(config);
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

function fulfillment(config, offerKey, payment) {
  const offer = offers[offerKey];
  const row = {
    at: now(),
    fulfillment_id: `VFF-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
    state: offer.fulfillment,
    offer: offer.code,
    amount_usd: offer.amount,
    config_id: config.config_id,
    config_version: config.version,
    config_hash: config.config_hash,
    customer_name: config.customer?.name || '',
    customer_email: config.customer?.email || '',
    stripe_checkout_session_id: payment.checkout_session_id,
    stripe_payment_intent_id: payment.payment_intent_id || null,
    external_action_allowed: false,
  };
  fs.appendFileSync(FULFILLMENT, JSON.stringify(row) + '\n');
  event('fulfillment_queued', config, { fulfillment_id: row.fulfillment_id, state: row.state, offer: row.offer });
  return row;
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
    config.lifecycle = Array.isArray(config.lifecycle) ? config.lifecycle : [];
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
    cwd: 'C:\\HDP\\EmailAgent',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Gmail send failed').trim());
  try { return JSON.parse((result.stdout || '{}').trim()); }
  catch (_) { return {}; }
}

function clientReference(config) {
  const hashHex = String(config.config_hash || '').replace(/^sha256:/, '');
  return `${config.config_id}~v${config.version}~${hashHex}`;
}

function parseClientReference(value) {
  const match = String(value || '').match(/^(VA-[A-F0-9]{10})~v(\d+)~([a-f0-9]{64})$/i);
  if (!match) return null;
  return { config_id: match[1].toUpperCase(), version: Number(match[2]), config_hash: `sha256:${match[3].toLowerCase()}` };
}

function checkoutUrl(key, config) {
  const base = checkoutUrls[key];
  if (!base || !paymentReady()) return null;
  const url = new URL(base);
  url.searchParams.set('client_reference_id', clientReference(config));
  if (config.customer?.email) url.searchParams.set('prefilled_email', config.customer.email);
  return url.toString();
}

function constantTimeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left || '')) || !/^[a-f0-9]{64}$/i.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(String(left).toLowerCase(), 'hex'), Buffer.from(String(right).toLowerCase(), 'hex'));
}

function verifyStripeSignature(rawBody, header, secret) {
  const parts = String(header || '').split(',').map((x) => x.trim()).filter(Boolean);
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i);
    const value = part.slice(i + 1);
    if (key === 't') timestamp = Number(value);
    if (key === 'v1') signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > STRIPE_WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return signatures.some((candidate) => constantTimeHexEqual(candidate, expected));
}

function offerKeyFromStripeSession(session) {
  const stripeOffer = String(session?.metadata?.hdp_offer || '');
  return Object.keys(offers).find((key) => offers[key].stripe_offer === stripeOffer) || null;
}

function paymentEmail(config, offerKey, payment) {
  const offer = offers[offerKey];
  const next = offerKey === 'managed_setup'
    ? 'Your Managed Implementation setup is paid and queued. HDP will use the saved configuration associated with this hash as the implementation starting point.'
    : offerKey === 'demo_activation'
      ? 'Your demo activation is paid and queued for provisioning. The $20 payment is recorded as initial voice/AI testing credit for this configuration.'
      : 'Your Go Live activation is paid and queued for production provisioning against this exact saved configuration.';
  return [
    `Hi ${config.customer?.name || 'there'},`, '',
    `Payment confirmed: ${offer.label} — $${offer.amount}.00`,
    `Configuration hash: ${config.config_hash}`,
    `Stripe checkout reference: ${payment.checkout_session_id}`, '',
    next, '',
    'If you contact HDP about this order, include the configuration hash above.', '',
    'Highest Degree Priorities',
  ].join('\n');
}

function reconcilePaidSession(session, eventType) {
  if (!session || session.object !== 'checkout.session') throw new Error('Unexpected Stripe object');
  if (session.livemode !== true) throw new Error('Non-live Stripe event rejected');
  if (String(session.currency || '').toLowerCase() !== 'usd') throw new Error('Unexpected currency');
  if (String(session.payment_status || '') !== 'paid') return { accepted: true, paid: false, reason: 'payment_not_settled' };
  if (String(session?.metadata?.hdp_product || '') !== 'voice_agent') throw new Error('Unexpected product metadata');

  const offerKey = offerKeyFromStripeSession(session);
  if (!offerKey) throw new Error('Unknown Stripe offer metadata');
  const offer = offers[offerKey];
  if (Number(session.amount_total) !== offer.amount * 100) throw new Error('Stripe amount mismatch');

  const ref = parseClientReference(session.client_reference_id);
  if (!ref) throw new Error('Missing or invalid client_reference_id');
  const config = load(ref.config_id);
  if (!config) throw new Error('Configuration not found');
  ensureCommercial(config);

  if (config.version !== ref.version || String(config.config_hash).toLowerCase() !== String(ref.config_hash).toLowerCase()) {
    event('stripe_payment_stale_config_rejected', config, {
      checkout_session_id: session.id,
      paid_version: ref.version,
      paid_hash: ref.config_hash,
      current_version: config.version,
      current_hash: config.config_hash,
    });
    throw new Error('Paid configuration version/hash no longer matches current saved configuration');
  }

  const existing = config.commercial.payments.find((p) => p.checkout_session_id === session.id);
  if (existing) return { accepted: true, paid: true, duplicate: true, config, payment: existing, offerKey };

  const intent = [...config.commercial.checkout_intents].reverse().find((x) =>
    x.offer === offer.code &&
    Number(x.config_version) === ref.version &&
    String(x.config_hash).toLowerCase() === String(ref.config_hash).toLowerCase() &&
    ['CHECKOUT_READY', 'PAID'].includes(x.status)
  );
  if (!intent) throw new Error('No matching checkout intent for paid configuration');

  const payment = {
    recorded_at: now(),
    provider: 'STRIPE',
    event_type: eventType,
    checkout_session_id: String(session.id),
    payment_intent_id: session.payment_intent ? String(session.payment_intent) : null,
    payment_status: String(session.payment_status),
    amount_usd: offer.amount,
    currency: 'usd',
    offer: offer.code,
    config_id: config.config_id,
    config_version: config.version,
    config_hash: config.config_hash,
    payer_email: String(session?.customer_details?.email || ''),
  };

  intent.status = 'PAID';
  intent.checkout_session_id = payment.checkout_session_id;
  intent.paid_at = payment.recorded_at;
  config.commercial.payments.push(payment);
  setStatus(config, offer.next, `Verified Stripe payment for ${offer.code}.`);
  save(config);
  const fulfillmentRecord = fulfillment(config, offerKey, payment);
  event('stripe_payment_verified', config, {
    checkout_session_id: payment.checkout_session_id,
    payment_intent_id: payment.payment_intent_id,
    offer: payment.offer,
    amount_usd: payment.amount_usd,
    fulfillment_id: fulfillmentRecord.fulfillment_id,
  });

  return { accepted: true, paid: true, duplicate: false, config, payment, offerKey, fulfillmentRecord };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      cors(req, res);
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/stripe/webhook') {
      const secret = stripeWebhookSecret();
      if (!secret) return send(req, res, 503, { error: 'Stripe webhook not configured' });
      const rawBody = await readRawBody(req, 1000000);
      if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], secret)) {
        return send(req, res, 400, { error: 'Invalid Stripe signature' });
      }
      let stripeEvent;
      try { stripeEvent = JSON.parse(rawBody.toString('utf8')); }
      catch (_) { return send(req, res, 400, { error: 'Invalid Stripe payload' }); }

      if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(stripeEvent.type)) {
        return send(req, res, 200, { received: true, ignored: true });
      }

      let result;
      try {
        result = reconcilePaidSession(stripeEvent?.data?.object, stripeEvent.type);
      } catch (error) {
        fs.appendFileSync(EVENTS, JSON.stringify({ at: now(), type: 'stripe_webhook_rejected', stripe_event_id: stripeEvent.id || null, error: error.message }) + '\n');
        return send(req, res, 400, { error: 'Payment reconciliation rejected' });
      }

      send(req, res, 200, { received: true, paid: Boolean(result.paid), duplicate: Boolean(result.duplicate) });
      if (result.paid && !result.duplicate && EMAIL_LIVE && !REVIEW) {
        setImmediate(() => {
          try {
            sendEmail(result.config.customer.email, `Payment confirmed — ${offers[result.offerKey].label}`, paymentEmail(result.config, result.offerKey, result.payment));
            event('payment_confirmation_emailed', result.config, { checkout_session_id: result.payment.checkout_session_id });
          } catch (error) {
            event('payment_confirmation_email_failed', result.config, { checkout_session_id: result.payment.checkout_session_id, error: error.message });
          }
        });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(req, res, 200, {
        ok: true,
        product: 'HDP Voice Configurator',
        version: '3.0.0',
        review_mode: REVIEW,
        payment_live: paymentReady(),
        payment_links_configured: Object.values(checkoutUrls).filter(Boolean).length,
        stripe_webhook_live: Boolean(stripeWebhookSecret()),
        email_live: EMAIL_LIVE,
        provisioning_live: false,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/offers') {
      const ready = paymentReady();
      return send(req, res, 200, {
        offers,
        payment_available: {
          demo_activation: ready && Boolean(checkoutUrls.demo_activation),
          go_live: ready && Boolean(checkoutUrls.go_live),
          managed_setup: ready && Boolean(checkoutUrls.managed_setup),
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
        client_reference_id: clientReference(config),
        status: checkout ? 'CHECKOUT_READY' : 'CHECKOUT_PREPARED_HOLD',
      };

      ensureCommercial(config);
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
        message: checkout ? 'Checkout is ready.' : 'Payment verification is not fully connected yet; your configuration remains saved.',
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
  console.log(`HDP Voice Configurator v3 listening on 127.0.0.1:${PORT}`);
});
