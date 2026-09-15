'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROFILE_DIR = process.env.HDP_CUSTOMER_PROFILE_DIR || 'C:\\HDP\\VoiceDemoCustomers\\profiles';
const CONTROL_TOKEN_FILE = process.env.HDP_CUSTOMER_DEMO_CONTROL_TOKEN_FILE || 'C:\\HDP\\VoiceDemoCustomers\\secrets\\control_token.txt';

function normalizeProfileId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function validProfileId(value) {
  return /^vc_[a-z0-9_-]{8,100}$/.test(normalizeProfileId(value));
}

function profilePath(id) {
  const normalized = normalizeProfileId(id);
  if (!validProfileId(normalized)) return null;
  return path.join(PROFILE_DIR, `${normalized}.json`);
}

function getProfile(id) {
  const normalized = normalizeProfileId(id);
  const file = profilePath(normalized);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (normalizeProfileId(parsed.id || parsed.profile_id) !== normalized) return null;
    if (parsed.active === false) return null;
    if (parsed.demoSafe !== true) return null;
    return parsed;
  } catch (error) {
    console.error('Customer profile load failed:', normalized, error.message);
    return null;
  }
}

function hasProfile(id) {
  return Boolean(getProfile(id));
}

function getControlToken() {
  try {
    if (!fs.existsSync(CONTROL_TOKEN_FILE)) return '';
    return fs.readFileSync(CONTROL_TOKEN_FILE, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
  const configured = getControlToken();
  if (!configured) return false;
  const header = String(req.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeTextEqual(supplied, configured);
}

module.exports = {
  PROFILE_DIR,
  CONTROL_TOKEN_FILE,
  normalizeProfileId,
  validProfileId,
  getProfile,
  hasProfile,
  getControlToken,
  isAuthorized,
};
