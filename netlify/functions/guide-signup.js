// guide-signup.js
// Buying Guide email capture. Creates or updates a HubSpot contact and returns.
// No deal, no task, no email sent. The page reveals the download on success.
//
// Environment variable, whichever name the site already uses:
//   HUBSPOT_TOKEN | HUBSPOT_PRIVATE_APP_TOKEN | HUBSPOT_ACCESS_TOKEN
//
// Optional HubSpot contact property: if a single-line text property with the
// internal name `guide_signup_source` exists, the source is written to it.
// If it does not exist the field is dropped and the request still succeeds.

const TOKEN =
  process.env.HUBSPOT_TOKEN ||
  process.env.HUBSPOT_PRIVATE_APP_TOKEN ||
  process.env.HUBSPOT_ACCESS_TOKEN ||
  '';

const HS = 'https://api.hubapi.com';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Deliberately permissive. Rejects obvious junk, not valid-but-unusual addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  if (!TOKEN) {
    console.error('guide-signup: no HubSpot token in environment');
    return json(500, { error: 'Server is not configured.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Bad request.' });
  }

  // Honeypot. Real people leave it empty; bots fill every field they find.
  if (String(body.company_website || '').trim() !== '') {
    return json(200, { ok: true });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const firstname = String(body.firstname || '').trim().slice(0, 80);
  const source = String(body.source || 'Buying Guide').trim().slice(0, 120);

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json(400, { error: 'Please enter a valid email address.' });
  }

  const base = { email };
  if (firstname) base.firstname = firstname;

  // Lifecycle and lead status are set on creation only. Overwriting them on an
  // existing contact would drag a paying client backwards to "lead".
  const createProps = { ...base, lifecyclestage: 'lead', hs_lead_status: 'NEW', guide_signup_source: source };
  const updateProps = { ...base, guide_signup_source: source };

  try {
    let res = await send('/crm/v3/objects/contacts', 'POST', createProps);

    // 409 means the email already exists. HubSpot returns the existing id in
    // the error message; fall back to a search if that shape ever changes.
    if (!res.ok && res.status === 409) {
      const id = await existingId(res, email);
      if (!id) return json(502, { error: 'Could not save your address.' });
      res = await send(`/crm/v3/objects/contacts/${id}`, 'PATCH', updateProps);
    }

    if (!res.ok) {
      console.error('guide-signup: HubSpot error', res.status, JSON.stringify(res.data));
      return json(502, { error: 'Could not save your address.' });
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error('guide-signup: exception', err);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
};

async function hs(path, method, payload) {
  const res = await fetch(HS + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

// Sends the properties, then retries once without any property HubSpot says it
// does not recognize. That keeps the custom source field optional.
async function send(path, method, props) {
  let res = await hs(path, method, { properties: props });
  if (res.ok) return res;

  const msg = JSON.stringify(res.data || '');
  const unknown = Object.keys(props).filter(
    (k) =>
      k !== 'email' &&
      msg.includes(`"${k}"`) &&
      /does not exist|not a valid|PROPERTY_DOESNT_EXIST/i.test(msg)
  );
  if (unknown.length === 0) return res;

  const trimmed = { ...props };
  unknown.forEach((k) => delete trimmed[k]);
  console.warn('guide-signup: dropping unknown properties', unknown.join(', '));
  return hs(path, method, { properties: trimmed });
}

async function existingId(conflictRes, email) {
  const msg = String(conflictRes?.data?.message || '');
  const m = msg.match(/Existing ID:\s*(\d+)/i) || msg.match(/\b(\d{6,})\b/);
  if (m) return m[1];

  const search = await hs('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'],
    limit: 1,
  });
  return search?.data?.results?.[0]?.id || null;
}
