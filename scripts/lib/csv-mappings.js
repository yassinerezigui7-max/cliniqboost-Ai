// Column mappings for patient-database CSV exports from each supported
// booking software. Each canonical field maps to an array of possible column
// names (matched case-insensitively, whitespace-trimmed) so exports from
// different plans/years still parse. Extend the arrays as new export
// variants show up — that's the whole point of this file.

const MAPPINGS = {
  vagaro: {
    first_name: ['First Name', 'FirstName', 'Customer First Name'],
    last_name: ['Last Name', 'LastName', 'Customer Last Name'],
    phone: ['Cell Phone', 'Phone Number', 'Mobile', 'Phone', 'Mobile Phone Number'],
    email: ['Email', 'Email Address'],
    last_visit: ['Last Visit', 'Last Visit Date', 'LastAppointment', 'Last Appointment'],
    total_visits: ['Total Visits', 'Number of Visits', 'AppointmentCount', 'Visits']
  },
  mindbody: {
    first_name: ['First Name', 'FirstName', 'Client First Name'],
    last_name: ['Last Name', 'LastName', 'Client Last Name'],
    phone: ['Mobile Phone', 'Cell Phone', 'Phone', 'Home Phone'],
    email: ['Client Email', 'Email', 'Email Address'],
    last_visit: ['Last Visit', 'Last Visit Date', 'Last Class Date'],
    total_visits: ['Total Visits', 'Visits', '# of Visits']
  },
  boulevard: {
    first_name: ['Client First Name', 'First Name'],
    last_name: ['Client Last Name', 'Last Name'],
    phone: ['Mobile Number', 'Mobile Phone', 'Phone Number', 'Phone'],
    email: ['Email Address', 'Email', 'Client Email'],
    last_visit: ['Last Appointment Date', 'Last Appointment', 'Last Visit'],
    total_visits: ['Appointment Count', 'Total Appointments', 'Total Visits']
  },
  zenoti: {
    first_name: ['Guest First Name', 'First Name'],
    last_name: ['Guest Last Name', 'Last Name'],
    phone: ['Mobile', 'Mobile Number', 'Phone', 'Guest Mobile'],
    email: ['Email', 'Guest Email', 'Email Address'],
    last_visit: ['Last Visited On', 'Last Visit Date', 'Last Visit'],
    total_visits: ['Visit Count', 'Total Visits', 'No Of Visits']
  },
  square: {
    first_name: ['Given Name', 'First Name'],
    last_name: ['Family Name', 'Surname', 'Last Name'],
    phone: ['Phone Number', 'Phone', 'Mobile Number'],
    email: ['Email Address', 'Email'],
    last_visit: ['Last Visit', 'Last Appointment Date', 'Last Appointment'],
    total_visits: ['Total Visits', 'Appointment Count', 'Transaction Count']
  }
};

// Columns that are DISTINCTIVE to one software — used by auto-detection to
// break ties. A header containing one of these strongly signals that source.
const SIGNATURE_COLUMNS = {
  vagaro: ['Cell Phone', 'Number of Visits'],
  mindbody: ['Mobile Phone', 'Client Email', 'Client ID', 'Last Class Date'],
  boulevard: ['Client First Name', 'Mobile Number', 'Appointment Count'],
  zenoti: ['Guest First Name', 'Guest Mobile', 'Last Visited On', 'Visit Count'],
  square: ['Given Name', 'Family Name', 'Transaction Count']
};

const norm = s => String(s || '').trim().toLowerCase();

// Resolve which actual CSV column supplies each canonical field for a given
// source. Returns { fieldName -> actualHeaderName } for the fields present.
function resolveColumns(source, headerRow) {
  const mapping = MAPPINGS[source];
  if (!mapping) throw new Error(`unknown source '${source}' — expected one of: ${Object.keys(MAPPINGS).join(', ')}`);
  const headerByNorm = new Map(headerRow.map(h => [norm(h), h]));
  const resolved = {};
  for (const [field, candidates] of Object.entries(mapping)) {
    for (const candidate of candidates) {
      const actual = headerByNorm.get(norm(candidate));
      if (actual !== undefined) { resolved[field] = actual; break; }
    }
  }
  return resolved;
}

// Detect the source software from the CSV header row. Scores every source by
// (matched fields, matched signature columns) and requires an unambiguous
// winner; returns { source } or { ambiguous: true, candidates } / { source: null }.
function detectSource(headerRow) {
  const headerSet = new Set(headerRow.map(norm));
  const scores = Object.keys(MAPPINGS).map(source => {
    const fieldsMatched = Object.keys(resolveColumns(source, headerRow)).length;
    const signatureHits = (SIGNATURE_COLUMNS[source] || [])
      .filter(c => headerSet.has(norm(c))).length;
    return { source, fieldsMatched, signatureHits };
  }).sort((a, b) =>
    (b.signatureHits - a.signatureHits) || (b.fieldsMatched - a.fieldsMatched)
  );

  const [best, second] = scores;
  // Must map at least the essentials (name + phone ≈ 3 fields) to count at all.
  if (!best || best.fieldsMatched < 3) return { source: null, scores };
  // Unambiguous: strictly more signature hits, or same signatures but clearly
  // more fields matched.
  const tied = second && second.signatureHits === best.signatureHits &&
    second.fieldsMatched === best.fieldsMatched;
  if (tied) return { ambiguous: true, candidates: [best.source, second.source], scores };
  if (best.signatureHits === 0 && second && second.fieldsMatched >= best.fieldsMatched) {
    return { ambiguous: true, candidates: [best.source, second.source], scores };
  }
  return { source: best.source, scores };
}

module.exports = { MAPPINGS, SIGNATURE_COLUMNS, resolveColumns, detectSource };
