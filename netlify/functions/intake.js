// THE REPORT - intake handler
// Receives the site intake form, creates a HubSpot contact and deal,
// then returns the Stripe payment link the browser should be sent to.
//
// Env vars required (Netlify > Site configuration > Environment variables):
//   HUBSPOT_TOKEN   private app token, scopes: crm.objects.contacts.write, crm.objects.deals.write
//
// ---------------------------------------------------------------------------
// HUBSPOT PROPERTY VALUES - verified against portal 247240184.
// These are the EXACT stored values, not the display labels. Three of them
// contain typos that exist in HubSpot itself. They are reproduced verbatim
// on purpose: a value that does not match exactly is silently dropped.
// If you correct any of these in HubSpot, correct them here the same day.
//
//   report_tier        "Area Edition ($150)"
//                      "Records Editon ($250)"                    <- typo: Editon
//                      "Full Edition ($750)"
//   addons_purchased   "Annual Refresh ($250)"
//                      "The Briefing ($9.99 mo)"
//                      "The Briefing W/Full Edition ($4.99 mom)"  <- typo: mom
//   referral_source    "jotapropeties.com"                        <- typo: propeties
//
// NOTE: report_tier has NO Annual Refresh or BRIEFING option, and that is
// correct. Those are add-ons, not tiers, and belong in addons_purchased.
// An Annual Refresh order therefore has an empty Report Tier by design.
//
// NOTE: there is no Zone property on deals. Zone is written into the deal
// note below so it is never lost. If you later create a Zone dropdown,
// tell Claude and it moves into structured data in one pass.
// ---------------------------------------------------------------------------

const HS = 'https://api.hubapi.com';

const PAYMENT_LINKS = {
  area_edition:       'https://buy.stripe.com/test_4gMeVc97E6Ma5Gy6AT73G03',
  records_edition:    'https://buy.stripe.com/test_cNi9ASabI9Ym3yq0cv73G00',
  full_edition:       'https://buy.stripe.com/test_28E3cu3Nk8Uic4W9N573G01',
  annual_refresh:     'https://buy.stripe.com/test_9B600i97E8Ui9WO3oH73G02',
  briefing_standard:  'https://buy.stripe.com/test_dRmbJ0dnUfiG6KCf7p73G04',
  briefing_discounted:'https://buy.stripe.com/test_dRmbJ0bfM6Mafh80cv73G05',
};

// Tiers only. Anything not in this map is not a tier.
const TIER_VALUES = {
  area_edition:    'Area Edition ($150)',
  records_edition: 'Records Editon ($250)',
  full_edition:    'Full Edition ($750)',
};

// Add-ons. These populate addons_purchased, never report_tier.
const ADDON_VALUES = {
  annual_refresh:      'Annual Refresh ($250)',
  briefing_standard:   'The Briefing ($9.99 mo)',
  briefing_discounted: 'The Briefing W/Full Edition ($4.99 mom)',
};

const INQUIRY_STAGE = 'appointmentscheduled'; // "Inquiry" in THE REPORT pipeline
const SOURCE_WEBSITE = 'jotapropeties.com';   // stored value; label reads jotapropertiescr.com

// The site's "How did you hear about us?" answers do not match the HubSpot
// Referral Source options, so they are mapped here. The buyer's exact answer
// is always preserved verbatim in the deal note regardless.
const REFERRAL_MAP = {
  'WhatsApp catalog': 'WhatsApp Inbound',
  'Referral from a friend or family member': 'Word of Mouth',
  'Google': SOURCE_WEBSITE,
  'Expat forum or community': 'Other',
  'Other': 'Other',
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

// Find an existing contact by email, or create one. Never creates duplicates.
async function upsertContact({ email, firstname, lastname, phone }) {
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
  // The site's field is named bot-field (Netlify Forms convention).
  if (form['bot-field'] || form.website) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // Field names below match the intake form on index.html exactly.
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
  } = form;

  if (!email || !tier || !PAYMENT_LINKS[tier]) {
    return { statusCode: 400, body: 'Missing or invalid email/tier' };
  }

  // The form collects one "Full name" field. Split on the first space.
  const [firstname, ...restOfName] = name.trim().split(/\s+/);
  const lastname = restOfName.join(' ');

  try {
    const contactId = await upsertContact({
      email,
      firstname: firstname || '',
      lastname,
      phone,
    });

    const who = name.trim() || email;
    const dealName = `${who} - ${tier.replace(/_/g, ' ')}`;

    const dealProps = {
      dealname: dealName,
      pipeline: 'default',
      dealstage: INQUIRY_STAGE,
      referral_source: REFERRAL_MAP[referral_source] || SOURCE_WEBSITE,
    };

    // A request is EITHER a tier OR an add-on. Never guess across the two.
    if (TIER_VALUES[tier]) {
      dealProps.report_tier = TIER_VALUES[tier];
    } else if (ADDON_VALUES[tier]) {
      dealProps.addons_purchased = ADDON_VALUES[tier];
      // report_tier intentionally left empty. Annual Refresh and THE BRIEFING
      // are not tiers, and forcing one in would corrupt tier reporting.
    }

    // The form's single "Property address, or zones of interest" field holds
    // an address for Records/Full and a list of zones for Area Edition.
    // Only store it as Property Address when it is actually a property.
    if (property && tier !== 'area_edition') {
      dealProps.property_address = property;
    }

    const deal = await hs('/crm/v3/objects/deals', 'POST', {
      properties: dealProps,
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
      }],
    });

    // Everything the deal record has no field for lands here, so nothing the
    // buyer told us is lost. Zone is the main one.
    const noteBody =
      `INTAKE FORM SUBMISSION\n` +
      `Request: ${edition || tier.replace(/_/g, ' ')}\n` +
      `Classified as: ${TIER_VALUES[tier] ? 'Report Tier' : ADDON_VALUES[tier] ? 'Add-On (no tier set)' : 'UNMAPPED - review manually'}\n\n` +
      `Property or zones: ${property || 'not provided'}\n` +
      (tier === 'area_edition'
        ? `(Area Edition, so the line above is zones of interest, not an address.)\n`
        : '') +
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

    // Send the buyer to checkout with their email prefilled and the deal id
    // riding along, so the webhook can match the payment back to this record.
    const url = new URL(PAYMENT_LINKS[tier]);
    url.searchParams.set('prefilled_email', email);
    url.searchParams.set('client_reference_id', deal.id);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, redirectUrl: url.toString(), dealId: deal.id }),
    };
  } catch (err) {
    console.error('intake failed:', err);
    // Never strand a buyer because the CRM had a bad moment. Send them to
    // checkout anyway and reconcile the record from the webhook.
    const url = new URL(PAYMENT_LINKS[tier]);
    url.searchParams.set('prefilled_email', email);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, redirectUrl: url.toString(), crmError: true }),
    };
  }
};
