// THE REPORT - intake handler
// Receives the site intake form, creates a HubSpot contact and deal, then
// creates a Stripe Checkout Session prefilled with everything the buyer
// already typed, and returns its URL for the browser to follow.
//
// This replaces the older static payment-link approach. The buyer now enters
// their details once, on your form, and sees only a payment screen at Stripe.
//
// Env vars required (Netlify > Project configuration > Environment variables):
//   HUBSPOT_TOKEN      service key, scopes: contacts read/write, deals read/write
//   STRIPE_SECRET_KEY  sk_test_... in sandbox, sk_live_... when you go live
//
// ---------------------------------------------------------------------------
// HUBSPOT PROPERTY VALUES - verified against portal 247240184.
// Exact stored values, typos included, reproduced deliberately. A value that
// does not match exactly is silently dropped by HubSpot.
//
//   report_tier        Area / Records / Full ONLY
//   addons_purchased   Annual Refresh and both BRIEFING rates
//   referral_source    "jotapropeties.com" is the stored value
//
// report_tier has no Annual Refresh or BRIEFING option, and that is correct.
// Those are add-ons, not tiers. There is no Zone property on deals, so zone
// is written into the deal note and carried to Stripe as metadata.
// ---------------------------------------------------------------------------

const HS = 'https://api.hubapi.com';
const STRIPE = 'https://api.stripe.com/v1';

const SITE = 'https://jotapropertiescr.com';
const SUCCESS_URL = `${SITE}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`;
const CANCEL_URL = `${SITE}/#get-started`;

// Stripe price IDs. SANDBOX values. Replace all six when you go live.
const PRICES = {
  area_edition:        { price: 'price_1UAJjgANWNWwClOG8pk5JSlv', mode: 'payment' },
  records_edition:     { price: 'price_1UAJinANWNWwClOGPWLmUdaY', mode: 'payment' },
  full_edition:        { price: 'price_1UAJhJANWNWwClOGrrKSGWTp', mode: 'payment' },
  annual_refresh:      { price: 'price_1UBF7pANWNWwClOGdHR33mZp', mode: 'payment' },
  briefing_standard:   { price: 'price_1UAKIXANWNWwClOGTUhchskz', mode: 'subscription' },
  briefing_discounted: { price: 'price_1UBF5zANWNWwClOG3lajGJq2', mode: 'subscription' },
};

// THE BRIEFING as an add-on. The discounted rate is earned by buying a Full
// Edition in the same transaction, which is why the tier decides the price
// here on the server rather than trusting anything the browser sends.
function briefingAddonFor(tier) {
  return tier === 'full_edition'
    ? { key: 'briefing_discounted', price: PRICES.briefing_discounted.price }
    : { key: 'briefing_standard',   price: PRICES.briefing_standard.price };
}

const TIER_VALUES = {
  area_edition:    'Area Edition ($150)',
  records_edition: 'Records Editon ($250)',
  full_edition:    'Full Edition ($750)',
};

const ADDON_VALUES = {
  annual_refresh:      'Annual Refresh ($250)',
  briefing_standard:   'The Briefing ($9.99 mo)',
  briefing_discounted: 'The Briefing W/Full Edition ($4.99 mom)',
};

const HS_PRODUCT_IDS = {
  area_edition: '329592921839',
  records_edition: '329592921840',
  full_edition: '329559218880',
  annual_refresh: '329787227870',
  briefing_standard: '329593642702',
  briefing_discounted: '329593642704',
};

const INQUIRY_STAGE = 'appointmentscheduled'; // "Inquiry" in THE REPORT pipeline
const SOURCE_WEBSITE = 'jotapropeties.com';

// Site's "How did you hear about us?" answers mapped onto HubSpot's options.
// The buyer's exact answer is preserved verbatim in the deal note either way.
const REFERRAL_MAP = {
  'WhatsApp catalog': 'WhatsApp Inbound',
  'Referral from a friend or family member': 'Word of Mouth',
  'Google': SOURCE_WEBSITE,
  'Expat forum or community': 'Other',
  'Other': 'Other',
};

// --- HubSpot -----------------------------------------------------------------

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

async function upsertHubspotContact({ email, firstname, lastname, phone }) {
  const found = await hs('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'],
    limit: 1,
  });

  if (found.total > 0) {
    const id = found.results[0].id;
    await hs(`/crm/v3/objects/contacts/${id}`, 'PATCH', {
      properties: { firstname, lastname, phone },
    });
    return id;
  }

  const created = await hs('/crm/v3/objects/contacts', 'POST', {
    properties: { email, firstname, lastname, phone },
  });
  return created.id;
}

// --- Stripe ------------------------------------------------------------------

// Stripe's API takes form-encoded bodies with bracket notation for nesting,
// so nested objects are flattened here. Avoids needing the Stripe SDK, which
// would require a build step this site does not have.
function encodeForm(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      encodeForm(value, name, out);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object') encodeForm(item, `${name}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }
  return out;
}

async function stripe(path, params, method = 'POST') {
  const body = params ? encodeForm(params).join('&') : undefined;
  const url = method === 'GET' && body ? `${STRIPE}${path}?${body}` : `${STRIPE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'GET' ? undefined : body,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${JSON.stringify(json.error || json)}`);
  }
  return json;
}

// Reuse a Stripe customer when one already exists for this email, so repeat
// buyers keep one record and one saved history instead of many.
async function upsertStripeCustomer({ email, name, phone }) {
  const found = await stripe('/customers', { email, limit: 1 }, 'GET');
  if (found.data && found.data.length > 0) {
    const id = found.data[0].id;
    await stripe(`/customers/${id}`, { name, phone });
    return id;
  }
  const created = await stripe('/customers', { email, name, phone });
  return created.id;
}

// Metadata values are capped by Stripe, so long free text is trimmed.
function clip(value, max = 450) {
  if (!value) return undefined;
  return String(value).slice(0, max);
}

// --- Handler -----------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let form;
  try {
    form = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Honeypot. Bots fill hidden fields; humans do not.
  if (form['bot-field'] || form.website) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // Field names match the intake form on index.html exactly.
  const {
    email,
    name = '',
    phone = '',
    tier_key: tier,
    edition = '',
    property = '',
    entity = '',
    hoa = '',
    agent_or_attorney = '',
    timeline = '',
    notes = '',
    referral_source = '',
    add_briefing = '',
  } = form;

  if (!email || !tier || !PRICES[tier]) {
    return { statusCode: 400, body: 'Missing or invalid email/tier' };
  }

  const [firstname, ...restOfName] = name.trim().split(/\s+/);
  const lastname = restOfName.join(' ');
  const isArea = tier === 'area_edition';

  // The buyer ticked the add-on box. Only meaningful on the four report
  // tiers; someone subscribing to THE BRIEFING alone cannot add it twice.
  const wantsBriefing =
    (add_briefing === 'yes' || add_briefing === 'on' || add_briefing === true) &&
    PRICES[tier].mode === 'payment';
  const briefing = wantsBriefing ? briefingAddonFor(tier) : null;

  let dealId = null;

  // Step 1: CRM. If this fails the buyer must still be able to pay, so the
  // error is logged and the checkout is built anyway. The webhook rebuilds
  // the record afterward.
  try {
    const contactId = await upsertHubspotContact({
      email,
      firstname: firstname || '',
      lastname,
      phone,
    });

    const dealProps = {
      dealname: `${name.trim() || email} - ${tier.replace(/_/g, ' ')}`,
      pipeline: 'default',
      dealstage: INQUIRY_STAGE,
      referral_source: REFERRAL_MAP[referral_source] || SOURCE_WEBSITE,
    };

    // The request itself is EITHER a tier OR an add-on. Never guess across
    // the two. A BRIEFING subscription bought alongside a tier is recorded
    // separately, in addons_purchased.
    if (TIER_VALUES[tier]) dealProps.report_tier = TIER_VALUES[tier];
    else if (ADDON_VALUES[tier]) dealProps.addons_purchased = ADDON_VALUES[tier];

    if (briefing) dealProps.addons_purchased = ADDON_VALUES[briefing.key];

    // For Area Edition the property box holds zones, not an address.
    if (property && !isArea) dealProps.property_address = property;

    const deal = await hs('/crm/v3/objects/deals', 'POST', {
      properties: dealProps,
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
      }],
    });
    dealId = deal.id;

    const noteBody =
      `INTAKE FORM SUBMISSION\n` +
      `Request: ${edition || tier.replace(/_/g, ' ')}\n` +
      `Classified as: ${TIER_VALUES[tier] ? 'Report Tier' : ADDON_VALUES[tier] ? 'Add-On (no tier set)' : 'UNMAPPED - review manually'}\n\n` +
      `${isArea ? 'Zones of interest' : 'Property'}: ${property || 'not provided'}\n` +
      `Entity: ${entity || 'not provided'}\n` +
      `HOA: ${hoa || 'not provided'}\n` +
      `Agent or attorney: ${agent_or_attorney || 'not provided'}\n` +
      `Timeline: ${timeline || 'not provided'}\n` +
      `Phone: ${phone || 'not provided'}\n` +
      `Heard about us: ${referral_source || 'not answered'}\n` +
      (notes ? `\nClient notes:\n${notes}\n` : '') +
      `\nSubmitted: ${new Date().toISOString()}\n` +
      `(Entity, HOA, agent, timeline and notes have no deal properties; they live here.)`;

    await hs('/crm/v3/objects/notes', 'POST', {
      properties: { hs_note_body: noteBody, hs_timestamp: Date.now() },
      associations: [{
        to: { id: deal.id },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
      }],
    });
  } catch (err) {
    console.error('HubSpot step failed, continuing to checkout:', err);
  }

  // Step 2: Stripe Checkout Session, prefilled from the form.
  try {
    const customerId = await upsertStripeCustomer({
      email,
      name: name.trim(),
      phone,
    });

    const { price } = PRICES[tier];

    // Adding a recurring item forces the whole session into subscription
    // mode. Stripe allows a one-time price to ride along in that mode, so
    // the report and the subscription are bought in a single transaction.
    const mode = briefing ? 'subscription' : PRICES[tier].mode;

    const lineItems = [{ price, quantity: 1 }];
    if (briefing) lineItems.push({ price: briefing.price, quantity: 1 });

    // Everything the buyer already told us rides along as metadata, so the
    // checkout screen asks for nothing except payment details.
    const metadata = {
      tier,
      hs_deal_id: dealId || '',
      hs_product_id: HS_PRODUCT_IDS[tier] || '',
      property_or_zones: clip(property),
      entity: clip(entity),
      hoa: clip(hoa),
      agent_or_attorney: clip(agent_or_attorney),
      timeline: clip(timeline),
      referral_source: clip(referral_source),
      client_notes: clip(notes),
      briefing_addon: briefing ? briefing.key : 'none',
    };

    const params = {
      mode,
      customer: customerId,
      line_items: lineItems,
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      billing_address_collection: 'required',
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message: "I accept THE REPORT's Terms of Service. Checking this box is my signature and forms the agreement for this order.",
        },
      },
      metadata,
    };

    if (dealId) params.client_reference_id = dealId;

    // Invoices can only be auto-generated for one-time payments.
    if (mode === 'payment') {
      params.invoice_creation = { enabled: true };
      params.payment_intent_data = { metadata };
    } else {
      params.subscription_data = { metadata };
    }

    const session = await stripe('/checkout/sessions', params);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, redirectUrl: session.url, dealId }),
    };
  } catch (err) {
    console.error('Stripe checkout creation failed:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'checkout_unavailable' }),
    };
  }
};
