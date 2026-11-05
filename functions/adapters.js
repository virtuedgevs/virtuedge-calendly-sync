'use strict';
// Thin wrappers around Calendly's API and Firestore (kept separate so core.js stays testable).
function makeApi(token) {
  return async function api(path) {
    const url = path.startsWith('http') ? path : 'https://api.calendly.com' + path;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error('Calendly API ' + res.status + ' for ' + url.split('?')[0]);
    return res.json();
  };
}
function makeDb(admin) {
  const db = admin.firestore(), FV = admin.firestore.FieldValue, cands = () => db.collection('ve_c'), stateRef = db.collection('ve_sync').doc('calendly');
  return {
    async getState() { const s = await stateRef.get(); return s.exists ? s.data() : { processed: {} }; },
    async setState(state) { await stateRef.set(state); },
    async listCandidates() { const snap = await cands().get(); return snap.docs.map(d => ({ id: d.id, data: d.data() })); },
    async updateCandidate(id, patch) { await cands().doc(id).update({ ...patch, updatedAt: FV.serverTimestamp(), updatedBy: 'calendly-sync', revision: FV.increment(1) }); },
    async createCandidate(id, data) { await cands().doc(id).create({ ...data, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(), updatedBy: 'calendly-sync', revision: 1 }); }
  };
}
module.exports = { makeApi, makeDb };
