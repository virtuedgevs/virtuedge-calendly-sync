'use strict';
// Optional: run one sync from a computer or a free scheduler (for example GitHub Actions) instead of a Firebase scheduled function.
// Needs env vars: CALENDLY_TOKEN and GOOGLE_APPLICATION_CREDENTIALS (path to a Firebase service-account key file).
const admin = require('firebase-admin');
const { runSync } = require('./core');
const { makeApi, makeDb } = require('./adapters');
admin.initializeApp();
runSync({ api: makeApi(process.env.CALENDLY_TOKEN), db: makeDb(admin) }).then(s => { console.log('Calendly sync finished', s); process.exit(0); }, e => { console.error(e); process.exit(1); });
