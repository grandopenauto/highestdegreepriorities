'use strict';

const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root) throw new Error('Usage: node patch-demo-v0002.js <runtime-root>');

function file(rel) { return path.join(root, rel); }
function read(rel) { return fs.readFileSync(file(rel), 'utf8'); }
function write(rel, text) { fs.writeFileSync(file(rel), text, 'utf8'); }
function replaceOnce(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`Patch anchor not found: ${label}`);
  return text.replace(from, to);
}

// 1) Dynamic customer profiles in campaignRouter.
{
  let text = read('src/campaignRouter.js');
  text = replaceOnce(
    text,
    "const legaldemo = require('./campaigns/legaldemo');",
    "const legaldemo = require('./campaigns/legaldemo');\nconst customerProfileRegistry = require('./customerProfileRegistry');",
    'campaignRouter require'
  );
  text = replaceOnce(
    text,
    `function getCampaign(value) {\n  const id = normalizeCampaignId(value || inboundCampaignId);\n  return applyEnvironmentOverrides(campaigns.get(id) || campaigns.get('roofdemo'));\n}`,
    `function getCampaign(value) {\n  const id = normalizeCampaignId(value || inboundCampaignId);\n  const customerProfile = customerProfileRegistry.getProfile(id);\n  if (customerProfile) return customerProfile;\n  return applyEnvironmentOverrides(campaigns.get(id) || campaigns.get('roofdemo'));\n}`,
    'campaignRouter getCampaign'
  );
  text = replaceOnce(
    text,
    `  listCampaigns,\n  resolveSpreadsheetId,`,
    `  listCampaigns,\n  isCustomerProfile: customerProfileRegistry.hasProfile,\n  resolveSpreadsheetId,`,
    'campaignRouter exports'
  );
  write('src/campaignRouter.js', text);
}

// 2) Paid demo profiles are conversation-only: no model tools/side effects.
{
  let text = read('src/realtimeBridge.js');
  text = replaceOnce(
    text,
    `    const toolDefs = tools.toolDefinitions || [];`,
    `    const toolDefs = campaignConfig.demoSafe === true ? [] : (tools.toolDefinitions || []);`,
    'realtime tool gate'
  );
  text = replaceOnce(
    text,
    `    lines.push(\`You are the AI assistant for \${campaign.companyName}.\`);`,
    `    lines.push(\`You are \${campaign.agentName || 'the AI assistant'}, the AI assistant for \${campaign.companyName}.\`);`,
    'agent name prompt'
  );
  text = replaceOnce(
    text,
    `    lines.push('Follow compliance boundaries and immediately respect do-not-contact requests.');`,
    `    lines.push('Follow compliance boundaries and immediately respect do-not-contact requests.');\n    if (campaign.demoSafe === true) {\n      lines.push('This is a customer-requested demonstration of the configured receptionist.');\n      lines.push('This demo is conversation-only. Do not claim that appointments, CRM updates, messages, transfers, purchases, or other external actions have actually occurred.');\n      lines.push('If the caller asks for an action that is not active in the demo, explain that the production or managed implementation can connect that capability.');\n    }`,
    'demo-safe prompt'
  );
  write('src/realtimeBridge.js', text);
}

// 3) Twilio hard duration limit support.
{
  let text = read('src/twilioClient.js');
  text = replaceOnce(
    text,
    `function initiateOutboundCall(leadId, to, campaignId) {\n  const campaign = campaignId || process.env.DEFAULT_DEMO_CAMPAIGN || 'roofdemo';\n  const url = \`\${config.publicBaseUrl}/outbound/voice?lead_id=\${encodeURIComponent(leadId || '')}&phone=\${encodeURIComponent(to || '')}&campaign=\${encodeURIComponent(campaign)}\`;\n  return client.calls.create({\n    to,\n    from: config.outboundCallerId || config.twilioPhoneNumber,\n    url,\n    statusCallback: \`\${config.publicBaseUrl}/twilio/status?campaign=\${encodeURIComponent(campaign)}\`,\n    statusCallbackMethod: 'POST',\n    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']\n  });\n}`,
    `function initiateOutboundCall(leadId, to, campaignId, options = {}) {\n  const campaign = campaignId || process.env.DEFAULT_DEMO_CAMPAIGN || 'roofdemo';\n  const url = \`\${config.publicBaseUrl}/outbound/voice?lead_id=\${encodeURIComponent(leadId || '')}&phone=\${encodeURIComponent(to || '')}&campaign=\${encodeURIComponent(campaign)}\`;\n  const createOptions = {\n    to,\n    from: config.outboundCallerId || config.twilioPhoneNumber,\n    url,\n    statusCallback: \`\${config.publicBaseUrl}/twilio/status?campaign=\${encodeURIComponent(campaign)}\`,\n    statusCallbackMethod: 'POST',\n    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']\n  };\n  const requestedLimit = Number(options.timeLimitSeconds || 0);\n  if (Number.isFinite(requestedLimit) && requestedLimit > 0) {\n    createOptions.timeLimit = Math.max(60, Math.min(Math.floor(requestedLimit), 600));\n  }\n  return client.calls.create(createOptions);\n}`,
    'twilio time limit'
  );
  write('src/twilioClient.js', text);
}

// 4) Token-protected customer demo call route.
{
  let text = read('src/app.js');
  text = replaceOnce(
    text,
    `const campaignContext = require('./campaignContext');`,
    `const campaignContext = require('./campaignContext');\nconst customerProfileRegistry = require('./customerProfileRegistry');`,
    'app customer registry require'
  );

  const marker = `app.post('/api/demo/:campaign/call', async (req, res) => {`;
  const customerRoute = `app.post('/api/customer-demo/:profile/call', async (req, res) => {\n  if (!customerProfileRegistry.isAuthorized(req)) {\n    return res.status(401).json({ success: false, message: 'Unauthorized' });\n  }\n  const profileId = customerProfileRegistry.normalizeProfileId(req.params.profile);\n  const profile = customerProfileRegistry.getProfile(profileId);\n  if (!profile) {\n    return res.status(404).json({ success: false, message: 'Customer demo profile not found' });\n  }\n  const phone = req.body && req.body.phone;\n  const requestedSeconds = Number((req.body && req.body.max_seconds) || 200);\n  const phoneUtils = require('./phoneUtils');\n  if (!phone || !phoneUtils.isValidPhoneNumber(phone)) {\n    return res.status(400).json({ success: false, message: 'A valid phone number is required' });\n  }\n  const normalized = phoneUtils.normalizePhoneNumber(phone);\n  if (!/^\\+1\\d{10}$/.test(normalized)) {\n    return res.status(400).json({ success: false, message: 'Paid self-service demo callbacks currently support US/Canada +1 numbers only' });\n  }\n  try {\n    const maxSeconds = Math.max(60, Math.min(Math.floor(requestedSeconds || 200), 300));\n    const call = await require('./twilioClient').initiateOutboundCall('', normalized, profileId, { timeLimitSeconds: maxSeconds });\n    return res.json({\n      success: true,\n      call_sid: call && call.sid ? call.sid : null,\n      profile_id: profileId,\n      max_seconds: maxSeconds\n    });\n  } catch (err) {\n    console.error('Customer demo call failed:', err);\n    return res.status(500).json({ success: false, message: 'Unable to start the demo call' });\n  }\n});\n\n`;
  if (!text.includes("app.post('/api/customer-demo/:profile/call'")) {
    if (!text.includes(marker)) throw new Error('Patch anchor not found: customer demo route');
    text = text.replace(marker, customerRoute + marker);
  }
  write('src/app.js', text);
}

console.log(JSON.stringify({ ok: true, runtime: root, version: 'customer-demo-v0002' }));
