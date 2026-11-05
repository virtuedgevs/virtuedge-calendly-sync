'use strict';
/**
 * VirtuEdge Calendly sync: core logic (no Firebase or network code in here, so it can be tested).
 * Every few minutes it asks Calendly for recent bookings and cancellations and writes them into the
 * candidate records the tracker app reads. Works with a FREE Calendly plan (it only reads the API).
 */

const EARLY_STAGES = ['', 'New Lead', 'Awaiting Discovery Call'];
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
};

const uuidOf = uri => String(uri || '').split('/').pop();
const emailKey = v => String(v || '').trim().toLowerCase();
const dayIn = (tz, date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

function splitName(inv) {
  const first = String(inv.first_name || '').trim(), last = String(inv.last_name || '').trim();
  if (first || last) return { firstName: first, lastName: last };
  const parts = String(inv.name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}
function answerFor(inv, regex) {
  const qa = (inv.questions_and_answers || []).find(q => regex.test(String(q.question || '')));
  return qa ? String(qa.answer || '').trim() : '';
}
function parseState(inv) {
  const raw = answerFor(inv, /\bstate\b/i); if (!raw) return '';
  const upper = raw.toUpperCase();
  if (US_STATES[upper]) return US_STATES[upper];
  const hit = Object.values(US_STATES).find(n => n.toLowerCase() === raw.toLowerCase());
  return hit || '';
}
function parsePhone(inv) { return String(inv.text_reminder_number || '').trim() || answerFor(inv, /phone|mobile|cell/i); }
const nextNumber = ids => ids.map(id => { const m = /^VE-(\d{1,6})$/.exec(String(id)); return m ? parseInt(m[1], 10) : NaN; }).filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), 0) + 1;
const fmtId = n => 'VE-' + String(n).padStart(4, '0');
const pushHistory = (old, entry) => [...(Array.isArray(old) ? old : []).slice(-59), entry];

async function listAll(api, firstPath) {
  const out = []; let path = firstPath, pages = 0;
  while (path && pages < 5) {
    const r = await api(path); out.push(...(r.collection || []));
    path = r.pagination && r.pagination.next_page ? r.pagination.next_page : ''; pages++;
  }
  return out;
}

async function runSync({ api, db, now = new Date(), tz = 'America/New_York', log = console }) {
  const stats = { checked: 0, updated: 0, created: 0, canceled: 0, skipped: 0, errors: 0 };
  const state = await db.getState();
  state.processed = state.processed || {};
  if (!state.userUri) state.userUri = (await api('/users/me')).resource.uri;

  const minStart = new Date(now.getTime() - 6 * 3600 * 1000).toISOString();
  const events = [];
  for (const status of ['active', 'canceled']) {
    const q = `/scheduled_events?user=${encodeURIComponent(state.userUri)}&status=${status}&min_start_time=${encodeURIComponent(minStart)}&sort=start_time:asc&count=100`;
    events.push(...await listAll(api, q));
  }
  stats.checked = events.length;
  const todo = events.filter(e => (state.processed[uuidOf(e.uri)] || {}).s !== e.status)
    .sort((a, b) => (a.status === b.status ? String(a.start_time).localeCompare(String(b.start_time)) : (a.status === 'active' ? -1 : 1)));

  if (todo.length) {
    let cands = await db.listCandidates();   // [{id,data}] including archived people. Only read when something changed.
    const today = dayIn(tz, now);
    for (const e of todo) {
      const uuid = uuidOf(e.uri);
      try {
        if (e.status === 'active') {
          const invs = await listAll(api, `/scheduled_events/${uuid}/invitees?status=active&count=100`);
          const inv = invs[0];
          if (!inv) { state.processed[uuid] = { s: e.status, t: e.start_time }; continue; }
          const key = emailKey(inv.email);
          const same = cands.filter(c => emailKey(c.data.email) === key && key);
          const live = same.find(c => !c.data.archivedAt);
          if (live) {
            const d = live.data, patch = { callAt: e.start_time, callSource: 'calendly', callEventUri: e.uri };
            if (EARLY_STAGES.includes(d.stage || '')) { patch.stage = 'Call Booked'; patch.stageHistory = pushHistory(d.stageHistory, { d: today, f: d.stage || '', t: 'Call Booked', by: 'calendly-sync' }); }
            if (!String(d.nextAction || '').trim()) patch.nextAction = 'Run the discovery call';
            await db.updateCandidate(live.id, patch); Object.assign(d, patch); stats.updated++;
          } else if (same.length) {
            log.warn(`Booking for ${key} matches an archived record (${same[0].id}); not creating a new candidate.`); stats.skipped++;
          } else {
            const nm = splitName(inv);
            let created = false;
            for (let attempt = 0; attempt < 5 && !created; attempt++) {
              const id = fmtId(nextNumber(cands.map(c => c.id)));
              const data = {
                id, dateAdded: today, firstName: nm.firstName, lastName: nm.lastName, phone: parsePhone(inv), email: String(inv.email || '').trim(),
                state: parseState(inv), source: 'Calendly', owner: '', stage: 'Call Booked', noShows: '0',
                callAt: e.start_time, callSource: 'calendly', callEventUri: e.uri, nextAction: 'Run the discovery call', nextFollowUp: '',
                stageHistory: [{ d: today, f: '', t: 'Call Booked', by: 'calendly-sync' }]
              };
              try { await db.createCandidate(id, data); cands.push({ id, data }); created = true; stats.created++; }
              catch (err) { if (err && (err.code === 6 || err.code === 'already-exists')) { cands.push({ id, data: {} }); continue; } throw err; }
            }
            if (!created) throw new Error('Could not find a free candidate ID.');
          }
        } else {   // canceled
          const hit = cands.find(c => c.data.callEventUri === e.uri);
          if (hit) {
            const patch = { callAt: '', callSource: '', callEventUri: '', nextAction: 'Call canceled. Offer a new time', nextFollowUp: today };
            await db.updateCandidate(hit.id, patch); Object.assign(hit.data, patch); stats.canceled++;
          }
        }
        state.processed[uuid] = { s: e.status, t: e.start_time };
      } catch (err) { stats.errors++; log.error(`Event ${uuid} failed: ${err && err.message}`); }   // not marked processed, so it is retried next run
    }
  }
  const cutoff = now.getTime() - 45 * 86400000;
  for (const [k, v] of Object.entries(state.processed)) if (new Date(v.t).getTime() < cutoff) delete state.processed[k];
  state.lastRun = now.toISOString(); state.lastStats = stats;
  await db.setState(state);
  return stats;
}

module.exports = { runSync, parseState, parsePhone, splitName, nextNumber, fmtId, uuidOf, EARLY_STAGES };
