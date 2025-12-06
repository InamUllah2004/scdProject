const fs = require('fs');
const path = require('path');

// Attach to db emitter
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'db.log');

// ensure log dir
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function writeLog(line) {
	const ts = new Date().toISOString();
	const out = `[${ts}] ${line}\n`;
	fs.appendFile(LOG_FILE, out, () => {});
	console.log(out.trim());
}

// safe subscribe: if db/emmiter load fails, don't crash
try {
	const db = require('../db');
	if (db && db.emitter && db.emitter.on) {
		db.emitter.on('add', rec => writeLog(`ADD id=${rec.id} name=${rec.name}`));
		db.emitter.on('update', rec => writeLog(`UPDATE id=${rec.id} name=${rec.name}`));
		db.emitter.on('delete', rec => writeLog(`DELETE id=${rec.id} name=${rec.name}`));
	}
} catch (e) {
	// couldn't attach to emitter; skip logging subscriptions for now
}

module.exports = {};
