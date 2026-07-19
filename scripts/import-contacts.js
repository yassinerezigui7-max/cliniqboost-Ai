// Universal patient-database CSV importer for client onboarding.
// Supports exports from Vagaro, Mindbody, Boulevard, Zenoti, and Square
// Appointments (column mappings in scripts/lib/csv-mappings.js).
//
// Usage:
//   node scripts/import-contacts.js --clinic=<uuid> --file=<path.csv> \
//     --source=<vagaro|mindbody|boulevard|zenoti|square|auto> \
//     [--dry-run] [--skip-invalid] [--status=patient]
//
// Behavior:
//   - Validates EVERYTHING before writing anything: a bad phone number aborts
//     the whole run (nothing written) unless --skip-invalid is passed.
//   - Dedupes on (clinic_id, phone_number): existing contacts get
//     last_visit_date / total_visits refreshed (only if newer/higher) and
//     name/email filled ONLY if currently empty — never overwrites data the
//     AI system may have enriched through real conversations.
//   - New contacts get status 'patient' (they're an existing database, not
//     fresh leads). Override with --status if needed.
//   - Skipped rows are written to <input>.errors.csv with a reason column.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const db = require('../server/services/supabase');
const { normalizePhone } = require('../server/services/phone');
const { MAPPINGS, resolveColumns, detectSource } = require('./lib/csv-mappings');

const CHUNK_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── args ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { flags: {} };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) fail(`unrecognized argument: ${raw}`);
    const [, key, value] = m;
    if (value === undefined) args.flags[key] = true;
    else args[key.replace(/-/g, '_')] = value;
  }
  return args;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  console.error('\nUsage: node scripts/import-contacts.js --clinic=<uuid> --file=<path.csv> --source=<vagaro|mindbody|boulevard|zenoti|square|auto> [--dry-run] [--skip-invalid] [--status=patient]');
  process.exit(1);
}

// ── defensive date parsing ─────────────────────────────────────
// Booking softwares export dates inconsistently: MM/DD/YYYY, YYYY-MM-DD,
// DD-MM-YYYY, full ISO. Returns 'YYYY-MM-DD' or null — never throws, an
// unparseable date must not abort an import.
function parseDateFlexible(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();

  const valid = (y, m, d) => {
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    // Round-trip check catches impossible dates like Feb 30 (Date rolls over).
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  // ISO: YYYY-MM-DD (optionally with time suffix)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return valid(+m[1], +m[2], +m[3]);

  // Slashes: MM/DD/YYYY by convention; flip to DD/MM if first part can't be a month.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    let [, a, b, y] = m.map(Number);
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return valid(y, a, b);
  }

  // Dashes with year last: DD-MM-YYYY by convention; flip if month slot > 12.
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    let [, d, mo, y] = m.map(Number);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return valid(y, mo, d);
  }

  return null;
}

// ── CSV escaping for the errors report ─────────────────────────
const csvEscape = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ── load ALL existing contacts for the clinic (paged) ──────────
async function loadExistingContacts(clinicId) {
  const byPhone = new Map();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.supabase
      .from('contacts')
      .select('id, phone_number, name, email, last_visit_date, total_visits')
      .eq('clinic_id', clinicId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const c of data || []) byPhone.set(c.phone_number, c);
    if (!data || data.length < PAGE) break;
  }
  return byPhone;
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const dryRun = !!args.flags['dry-run'];
  const skipInvalid = !!args.flags['skip-invalid'];
  const status = args.status || 'patient';

  if (!args.clinic || !UUID_RE.test(args.clinic)) fail('--clinic=<uuid> is required');
  if (!args.file) fail('--file=<path.csv> is required');
  if (!args.source) fail('--source is required (or use --source=auto)');
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) fail(`file not found: ${filePath}`);

  // Clinic — also supplies the default phone region (clinic.country).
  const clinic = await db.getClinicById(args.clinic);
  if (!clinic) fail(`no clinic found with id ${args.clinic}`);
  console.log(`Clinic: ${clinic.name} (${clinic.country || 'no country'} → phone region default)`);

  // Parse CSV.
  const records = parse(fs.readFileSync(filePath, 'utf8'), {
    columns: header => header.map(h => String(h).trim()),
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: true
  });
  if (records.length === 0) fail('CSV contains no data rows');
  const header = Object.keys(records[0]);

  // Source resolution.
  let source = String(args.source).toLowerCase();
  if (source === 'auto') {
    const det = detectSource(header);
    if (det.ambiguous) {
      fail(`could not auto-detect source — header matches multiple formats (${det.candidates.join(', ')}). Re-run with --source=<name>.`);
    }
    if (!det.source) {
      fail(`could not auto-detect source from header [${header.join(', ')}]. Re-run with --source=<name>.`);
    }
    source = det.source;
    console.log(`Source auto-detected: ${source}`);
  } else if (!MAPPINGS[source]) {
    fail(`unknown --source '${source}' — expected one of: ${Object.keys(MAPPINGS).join(', ')}, auto`);
  }

  const cols = resolveColumns(source, header);
  if (!cols.phone) fail(`no phone column found for source '${source}' in header [${header.join(', ')}]`);
  if (!cols.first_name && !cols.last_name) fail(`no name column found for source '${source}'`);
  console.log(`Columns mapped: ${Object.entries(cols).map(([f, c]) => `${f}←"${c}"`).join('  ')}`);

  // ── Pass 1: normalize + validate every row BEFORE any write ──
  const skipped = []; // { row, rowNumber, reason }
  const byPhone = new Map(); // e164 → merged canonical row
  records.forEach((row, i) => {
    const rowNumber = i + 2; // 1-based + header row
    const rawPhone = row[cols.phone];
    const norm = normalizePhone(String(rawPhone || ''), clinic.country);
    if (!norm.valid || !norm.e164) {
      skipped.push({ row, rowNumber, reason: `bad phone "${rawPhone || ''}" (${norm.reason || 'invalid'})` });
      return;
    }

    const name = [row[cols.first_name], row[cols.last_name]]
      .map(v => String(v || '').trim()).filter(Boolean).join(' ') || null;
    const email = String(row[cols.email] || '').trim() || null;
    const lastVisit = cols.last_visit ? parseDateFlexible(row[cols.last_visit]) : null;
    const visitsRaw = cols.total_visits ? parseInt(String(row[cols.total_visits]).replace(/[^\d-]/g, ''), 10) : NaN;
    const totalVisits = Number.isFinite(visitsRaw) && visitsRaw >= 0 ? visitsRaw : 0;

    // In-file duplicate (same phone twice): merge — latest visit, highest
    // visit count, first non-empty name/email.
    const existing = byPhone.get(norm.e164);
    if (existing) {
      if (lastVisit && (!existing.last_visit_date || lastVisit > existing.last_visit_date)) existing.last_visit_date = lastVisit;
      if (totalVisits > existing.total_visits) existing.total_visits = totalVisits;
      if (!existing.name && name) existing.name = name;
      if (!existing.email && email) existing.email = email;
      existing.mergedRows.push(rowNumber);
      return;
    }
    byPhone.set(norm.e164, {
      phone_number: norm.e164, name, email,
      last_visit_date: lastVisit, total_visits: totalVisits,
      mergedRows: [rowNumber]
    });
  });

  if (skipped.length > 0 && !skipInvalid) {
    console.error(`✗ ${skipped.length} row(s) have invalid phone numbers (first: row ${skipped[0].rowNumber}: ${skipped[0].reason}).`);
    console.error('  Nothing was written. Fix the CSV, or re-run with --skip-invalid to import the valid rows.');
    process.exit(1);
  }

  // ── Plan against existing DB contacts ──
  const existingByPhone = await loadExistingContacts(clinic.id);
  const inserts = [];
  const updates = []; // { id, patch, phone }
  let unchanged = 0;
  for (const row of byPhone.values()) {
    const existing = existingByPhone.get(row.phone_number);
    if (!existing) {
      inserts.push({
        clinic_id: clinic.id,
        phone_number: row.phone_number,
        name: row.name,
        email: row.email,
        last_visit_date: row.last_visit_date,
        total_visits: row.total_visits,
        status
      });
      continue;
    }
    const patch = {};
    if (row.last_visit_date && (!existing.last_visit_date || row.last_visit_date > existing.last_visit_date)) {
      patch.last_visit_date = row.last_visit_date;
    }
    if (row.total_visits > (existing.total_visits || 0)) patch.total_visits = row.total_visits;
    if (row.name && !existing.name) patch.name = row.name;
    if (row.email && !existing.email) patch.email = row.email;
    if (Object.keys(patch).length === 0) { unchanged++; continue; }
    patch.updated_at = new Date().toISOString();
    updates.push({ id: existing.id, patch, phone: row.phone_number });
  }

  const summary = () => {
    console.log('');
    console.log(`  ✓ Read: ${records.length} rows (${byPhone.size} unique phone numbers)`);
    console.log(`  ✓ Inserted: ${inserts.length} new contacts`);
    console.log(`  ↻ Updated: ${updates.length} existing contacts (last visit / total visits refreshed)`);
    if (unchanged > 0) console.log(`  – Unchanged: ${unchanged} existing contacts (CSV had nothing newer)`);
    console.log(`  ⚠ Skipped: ${skipped.length} rows (bad phone numbers)`);
    console.log(`  ✗ Errors: ${errors.length}`);
  };

  const errors = [];
  if (dryRun) {
    console.log('\n[DRY RUN] no writes performed — this is what WOULD happen:');
    summary();
    writeErrorsCsv(filePath, header, skipped);
    process.exit(0);
  }

  // ── Apply: chunked inserts, per-row conditional updates ──
  for (let i = 0; i < inserts.length; i += CHUNK_SIZE) {
    const chunk = inserts.slice(i, i + CHUNK_SIZE);
    const { error } = await db.supabase.from('contacts').insert(chunk);
    if (error) {
      errors.push({ reason: `insert chunk ${i / CHUNK_SIZE + 1} failed: ${error.message}` });
      console.error(`✗ insert chunk failed (${chunk.length} rows): ${error.message}`);
    } else {
      process.stdout.write(`  inserted ${Math.min(i + CHUNK_SIZE, inserts.length)}/${inserts.length}\r`);
    }
  }
  if (inserts.length > 0) console.log('');

  for (const u of updates) {
    const { error } = await db.supabase.from('contacts').update(u.patch).eq('id', u.id);
    if (error) errors.push({ reason: `update ${u.phone} failed: ${error.message}` });
  }

  summary();
  writeErrorsCsv(filePath, header, skipped);
  process.exit(errors.length > 0 ? 1 : 0);
}

// Skipped/errored rows → <input>.errors.csv with a trailing "reason" column.
function writeErrorsCsv(filePath, header, skipped) {
  if (skipped.length === 0) return;
  const errPath = filePath.replace(/\.csv$/i, '') + '.errors.csv';
  const lines = [[...header, 'reason'].map(csvEscape).join(',')];
  for (const s of skipped) {
    lines.push([...header.map(h => s.row[h]), s.reason].map(csvEscape).join(','));
  }
  fs.writeFileSync(errPath, lines.join('\n') + '\n');
  console.log(`  → skipped rows written to ${errPath}`);
}

main().catch(err => {
  console.error('✗ fatal:', err.message || err);
  process.exit(1);
});
