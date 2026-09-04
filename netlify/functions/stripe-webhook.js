// THE REPORT - Stripe webhook handler
// Listens for completed checkouts, advances the HubSpot deal to Payment Rcvd,
// and logs the terms acceptance record that stands in for a signature.
//
// Env vars required:
//   STRIPE_WEBHOOK_SECRET   whsec_... from the endpoint you create in Stripe
//   HUBSPOT_TOKEN           same private app token as intake.js
//   TERMS_VERSION           e.g. "1.0"  (bump when you publish new terms)
//
// Stripe dashboard > Developers > Webhooks > add endpoint:
//   https://jotapropertiescr.com/.netlify/functions/stripe-webhook
//   event: checkout.session.completed
//
// ---------------------------------------------------------------------------
// HUBSPOT PROPERTY VALUES - verified against portal 247240184.
// Exact stored values, typos included, reproduced deliberately. See the same
// block in intake.js. Keep the two files in sync.
//
//   report_tier        Area / Records / Full ONLY.
//   addons_purchased   Annual Refresh and both BRIEFING rates.
//   zone               dropdown, values capitalized (see ZONE_VALUES below).
// ---------------------------------------------------------------------------

// No npm packages required. Signature verification uses Node's built-in
// crypto module, so this file runs on Netlify with no build step.
const crypto = require('crypto');

const HS = 'https://api.hubapi.com';
const PAYMENT_RCVD_STAGE = 'presentationscheduled'; // "Payment Rcvd" in THE REPORT pipeline

const TIER_VALUES = {
  area_edition:    'Area Edition ($150)',
  records_edition: 'Records Editon ($250)',   // typo: Editon
  full_edition:    'Full Edition ($750)',
};

const ADDON_VALUES = {
  annual_refresh:      'Annual Refresh ($250)',
  briefing_standard:   'The Briefing ($9.99 mo)',
  briefing_discounted: 'The Briefing W/Full Edition ($4.99 mom)',  // typo: mom
};

// Form zone values mapped to the HubSpot Zone property's stored values.
// HubSpot's values are capitalized. A value that does not match exactly is
// silently dropped, so keep this map in step with the property.
const ZONE_VALUES = {
  'escazu':       'Escazu',
  'santa ana':    'Santa Ana',
  'lindora':      'Lindora',
  'san rafael':   'San Rafael',
  'alajuela':     'Alajuela',
  'atenas':       'Atenas',
  'ciudad colon': 'Ciudad Colon',
  'belen':        'Belen',
  'other':        'Other Central Valley',
  'multiple':     'Multiple Zones',
};

async function hs(path, method, body) {
  const res = await fetch(`${HS}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HubSpot ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

async function upsertContact({ email, name, phone }) {
  const found = await hs('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'],
    limit: 1,
  });
  if (found.total > 0) return found.results[0].id;

  const [firstname, ...rest] = (name || '').split(' ');
  const created = await hs('/crm/v3/objects/contacts', 'POST', {
    properties: { email, firstname: firstname || '', lastname: rest.join(' '), phone: phone || '' },
  });
  return created.id;
}

// Pulls the buyer's answers into a flat object.
// Sessions created by intake.js carry everything in metadata, since the form
// already collected it. Older payment-link sessions carry it in custom_fields.
// Both shapes are read so nothing is lost either way.
function readAnswers(session) {
  const out = {};

  for (const f of session.custom_fields || []) {
    out[f.key] = f.text?.value ?? f.dropdown?.value ?? f.numeric?.value ?? '';
  }

  const m = session.metadata || {};
  if (m.property_or_zones && !out.propertyaddress) out.propertyaddress = m.property_or_zones;
  if (m.zone && !out.zone) out.zone = m.zone;
  for (const key of ['entity', 'hoa', 'agent_or_attorney', 'timeline', 'referral_source', 'client_notes']) {
    if (m[key]) out[key] = m[key];
  }

  return out;
}

// Verifies the Stripe-Signature header without the Stripe SDK.
// Stripe signs `${timestamp}.${rawBody}` with your webhook secret.
function verifyStripeSignature(rawBody, header, secret, toleranceSeconds = 300) {
  if (!header || !secret) return false;

  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=').map((s) => s.trim()))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject replays of old requests.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  // Netlify may hand the body over base64 encoded. Signature is computed on
  // the raw string, so decode before verifying and before parsing.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const signatureHeader =
    event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  if (!verifyStripeSignature(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error('Signature verification failed');
    return { statusCode: 400, body: 'Webhook signature verification failed' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  const tier = session.metadata?.tier || 'unknown';
  const fields = readAnswers(session);
  const email = session.customer_details?.email;
  const amount = (session.amount_total || 0) / 100;

  const isTier = Boolean(TIER_VALUES[tier]);
  const isAddon = Boolean(ADDON_VALUES[tier]);

  // A BRIEFING subscription bought alongside a report rides in metadata.
  const briefingKey = session.metadata?.briefing_addon;
  const briefingAddon = briefingKey && briefingKey !== 'none' && ADDON_VALUES[briefingKey]
    ? briefingKey
    : null;

  try {
    // intake.js sets both, so either one identifies the deal it created.
    let dealId = session.client_reference_id || session.metadata?.hs_deal_id || null;

    // No deal id means they bought from a direct link rather than the intake
    // form. Build the record from scratch so nothing is lost.
    if (!dealId) {
      const contactId = await upsertContact({
        email,
        name: session.customer_details?.name,
        phone: session.customer_details?.phone,
      });

      const props = {
        dealname: `${session.customer_details?.name || email} - ${tier.replace(/_/g, ' ')}`,
        pipeline: 'default',
        dealstage: PAYMENT_RCVD_STAGE,
        amount: String(amount),
        referral_source: 'Other',
      };
      if (isTier) props.report_tier = TIER_VALUES[tier];
      if (isAddon) props.addons_purchased = ADDON_VALUES[tier];
      if (briefingAddon) props.addons_purchased = ADDON_VALUES[briefingAddon];
      if (fields.propertyaddress) props.property_address = fields.propertyaddress;
      if (ZONE_VALUES[fields.zone]) props.zone = ZONE_VALUES[fields.zone];

      const deal = await hs('/crm/v3/objects/deals', 'POST', {
        properties: props,
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
        }],
      });
      dealId = deal.id;
    } else {
      const props = {
        dealstage: PAYMENT_RCVD_STAGE,
        amount: String(amount),
      };
      // Confirm classification at payment time. intake.js set this already,
      // but a direct-link purchase or an edited link could differ.
      if (isTier) props.report_tier = TIER_VALUES[tier];
      if (isAddon) props.addons_purchased = ADDON_VALUES[tier];
      if (briefingAddon) props.addons_purchased = ADDON_VALUES[briefingAddon];
      if (fields.propertyaddress) props.property_address = fields.propertyaddress;
      if (ZONE_VALUES[fields.zone]) props.zone = ZONE_VALUES[fields.zone];
      await hs(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: props });
    }

    // The acceptance record. This is what stands in for a signed engagement
    // agreement, so it is written verbatim and never overwritten.
    const accepted = session.consent?.terms_of_service === 'accepted';
    const paidAt = new Date((session.created || Date.now() / 1000) * 1000).toISOString();

    const classification = isTier
      ? `Report Tier: ${TIER_VALUES[tier]}`
      : isAddon
        ? `Add-On: ${ADDON_VALUES[tier]} (no Report Tier set, by design)`
        : `UNMAPPED tier "${tier}" - review this deal manually`;

    const noteBody =
      `PAYMENT RECEIVED\n` +
      `Amount: $${amount.toFixed(2)} ${(session.currency || 'usd').toUpperCase()}\n` +
      `${classification}\n` +
      (briefingAddon ? `Add-on purchased: ${ADDON_VALUES[briefingAddon]}\n` : '') +
      `Stripe session: ${session.id}\n` +
      `Paid: ${paidAt}\n\n` +
      `TERMS ACCEPTANCE\n` +
      `Accepted: ${accepted ? 'YES' : 'NOT RECORDED - INVESTIGATE'}\n` +
      `Terms version: ${process.env.TERMS_VERSION || 'unset'}\n` +
      `Accepted at: ${accepted ? paidAt : 'n/a'}\n\n` +
      `CHECKOUT ANSWERS\n` +
      (Object.keys(fields).length
        ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
        : 'none') +
      `\n\n(Zone is recorded here because deals have no Zone property.)`;

    await hs('/crm/v3/objects/notes', 'POST', {
      properties: { hs_note_body: noteBody, hs_timestamp: Date.now() },
      associations: [{
        to: { id: dealId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
      }],
    });

    // Work queue: one task per paid order so nothing sits unnoticed.
    await hs('/crm/v3/objects/tasks', 'POST', {
      properties: {
        hs_task_subject: `Begin work: ${tier.replace(/_/g, ' ')}`,
        hs_task_body: fields.propertyaddress
          ? `Zone: ${fields.zone || 'not selected'}\n` +
            `Property location: ${fields.propertyaddress}\n` +
            (fields.folioreal ? `Folio Real: ${fields.folioreal}\n` : '') +
            (fields.priorreport ? `Prior report date: ${fields.priorreport}\n` : '')
          : `Zones: ${fields.zones || 'see deal'}\n` +
            `Timeline: ${fields.timeline || 'not provided'}\n` +
            (fields.priorities ? `Priorities: ${fields.priorities}\n` : ''),
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: tier === 'full_edition' ? 'HIGH' : 'MEDIUM',
        hs_timestamp: Date.now(),
      },
      associations: [{
        to: { id: dealId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }],
      }],
    });

    // Annual Refresh reminder. Eleven months out, so the outreach lands
    // before the anniversary rather than after it. This is a task for YOU,
    // not an email to the client: the refresh stays client-initiated, and
    // nothing here implies THE REPORT is monitoring the property.
    if (isTier && tier !== 'area_edition') {
      const ELEVEN_MONTHS = 334 * 24 * 60 * 60 * 1000;
      await hs('/crm/v3/objects/tasks', 'POST', {
        properties: {
          hs_task_subject: `Offer Annual Refresh: ${fields.propertyaddress || 'see deal'}`,
          hs_task_body:
            `Eleven months since this report was delivered.\n\n` +
            `Property location: ${fields.propertyaddress || 'see deal'}\n` +
            `Zone: ${fields.zone || 'not selected'}\n` +
            `Original tier: ${TIER_VALUES[tier]}\n\n` +
            `Send the refresh page: https://jotapropertiescr.com/refresh.html\n\n` +
            `Offer the service, do not imply we have been watching the property. ` +
            `No language such as "we noticed a change" or "it may be time to re-check."`,
          hs_task_status: 'NOT_STARTED',
          hs_task_priority: 'LOW',
          hs_timestamp: Date.now() + ELEVEN_MONTHS,
        },
        associations: [{
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }],
        }],
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, dealId }) };
  } catch (err) {
    console.error('webhook processing failed:', err);
    // Return 500 so Stripe retries. The payment already succeeded; only the
    // CRM write failed, and Stripe will redeliver this event.
    return { statusCode: 500, body: 'CRM update failed' };
  }
};
