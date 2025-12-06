const { MongoClient, ObjectId } = require('mongodb');
const vaultEvents = require('../events');
const fs = require('fs');
const path = require('path');

// Build MONGO_URI from environment (moved to .env). No hardcoded production URI here
let MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.warn('MONGO_URI not set in environment. Falling back to mongodb://localhost:27017/nodevault for local testing.');
  MONGO_URI = 'mongodb://localhost:27017/nodevault';
}

// helper: extract DB name from a mongodb URI (supports mongodb and mongodb+srv)
function extractDbName(uri) {
  if (!uri) return null;
  // match first path segment after the hosts portion, before any ? options
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^\/]+\/([^?\/]+)(?:\?|$)/);
  if (m && m[1]) return decodeURIComponent(m[1]);
  return null;
}

const detectedDbName = extractDbName(MONGO_URI);
const DEFAULT_DB = 'nodevault';
const resolvedDbName = detectedDbName || DEFAULT_DB;

console.log('Using MongoDB URI:', MONGO_URI);
if (detectedDbName) {
  console.log('Detected DB name from URI:', detectedDbName);
} else {
  console.log(`No DB name found in URI — defaulting to "${DEFAULT_DB}".`);
  console.log('If you want to use your Compass DB, set MONGO_URI to include the DB name, e.g.:');
  console.log("  mongodb://localhost:27017/scd_Project");
}

let client;
let collection;
let dbNameInUse = resolvedDbName;
// static numeric userID counter (will be initialized on connect)
let staticUserId = 1;

// backups directory (project root /backups)
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

async function ensureBackupDir() {
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  } catch (e) {
    // ignore mkdir errors; file writes will fail later if necessary
  }
}

// create a timestamped backup of the entire vault (JSON)
async function createBackup() {
  if (!collection) {
    // if not connected yet, try to connect
    try { await ensureConnection(); } catch (e) { console.error('Backup: failed to ensure DB connection:', e); return; }
  }
  await ensureBackupDir();
  try {
    const docs = await collection.find({}).toArray();
    const exportDocs = docs.map(d => ({
      _id: d._id ? String(d._id) : null,
      userID: d.userID || null,
      name: d.name || null,
      value: d.value || null,
      createdAt: d.createdAt || null
    }));
    const now = new Date();
    const stamp = now.toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
    const filename = `backup_${stamp}.json`; // e.g., backup_2025-11-04T15-22-10.json
    const filePath = path.join(BACKUP_DIR, filename);
    await fs.promises.writeFile(filePath, JSON.stringify(exportDocs, null, 2), 'utf8');
    console.log(`Backup created: ${filePath}`);
  } catch (err) {
    console.error('Failed to create backup:', err && err.message ? err.message : err);
  }
}

// Lazily connect and set collection
async function ensureConnection() {
  if (collection) return;
  if (!client) {
    // newer mongodb drivers don't accept useNewUrlParser/useUnifiedTopology options
    client = new MongoClient(MONGO_URI);
    try {
      await client.connect();
    } catch (err) {
      console.error('Failed to connect to MongoDB with MONGO_URI:', MONGO_URI);
      console.error('Check that MongoDB is running and the URI is correct (host, port, auth).');
      console.error('Example for Compass-local DB: mongodb://localhost:27017/scd_Project');
      throw err;
    }
  }

  // Determine DB name to use (prefer extracted name, fallback to DEFAULT_DB)
  dbNameInUse = detectedDbName || DEFAULT_DB;
  const db = client.db(dbNameInUse);
  collection = db.collection('records');
  // initialize staticUserId from max existing userID in collection
  try {
    const maxArr = await collection.find({ userID: { $exists: true } }, { projection: { userID: 1 } })
      .sort({ userID: -1 }).limit(1).toArray();
    if (maxArr && maxArr.length) {
      const maxVal = maxArr[0].userID;
      if (typeof maxVal === 'number' && Number.isFinite(maxVal)) staticUserId = maxVal + 1;
    }
  } catch (e) {
    // ignore; keep default staticUserId = 1
  }
  console.log(`Connected to MongoDB. Using database: "${dbNameInUse}", collection: "records"`);
  console.log(`Next userID will start at: ${staticUserId}`);
  // ensure backup dir exists once connected
  await ensureBackupDir();
  // optional: ensure indexes here if needed
}

// Helpers
function toPublic(doc) {
  if (!doc) return null;
  // safe extraction of _id: guard against undefined _id to avoid toString() errors
  let id = null;
  if (doc._id) {
    try { id = doc._id.toString(); } catch (e) { id = String(doc._id); }
  } else if (doc.id) {
    id = String(doc.id);
  }
  // include a formatted created date (YYYY-MM-DD) if createdAt exists
  const created = doc.createdAt ? String(doc.createdAt).slice(0,10) : null;
  // include raw ISO timestamps so CLI can compute stats; include formatted updated (YYYY-MM-DD HH:MM:SS)
  const createdAtISO = doc.createdAt || null;
  const updatedAtISO = doc.updatedAt || null;
  const updated = updatedAtISO ? (new Date(updatedAtISO).toISOString().replace('T',' ').split('.')[0]) : null;
  return { id, userID: doc.userID || null, name: doc.name, value: doc.value, created, createdAt: createdAtISO, updatedAt: updatedAtISO, updated };
}

// build query from an incoming id (supports numeric userID or ObjectId)
function getQueryFromId(id) {
  if (id === undefined || id === null) return { _id: { $exists: false } }; // will not match anything
  if (typeof id === 'number') return { userID: id };
  const s = String(id).trim();
  if (s.length === 0) return { _id: { $exists: false } };
  if (/^\d+$/.test(s)) {
    return { userID: parseInt(s, 10) };
  }
  // try ObjectId, otherwise produce a non-matching query
  try {
    return { _id: new ObjectId(s) };
  } catch (e) {
    return { _id: { $exists: false } };
  }
}

// API (all async)
async function init() {
  await ensureConnection();
}

async function close() {
  if (client) {
    try { await client.close(); } catch (e) { /* ignore */ }
    client = null;
    collection = null;
  }
}

async function addRecord({ name, value }) {
  await ensureConnection();
  const userID = staticUserId++;
  // store createdAt as ISO string so it's easy to show/formatted later
  const createdAt = new Date().toISOString();
  const res = await collection.insertOne({ name, value, userID, createdAt });
  const doc = await collection.findOne({ _id: res.insertedId });
  const out = toPublic(doc);
  try { vaultEvents.emit('recordAdded', out); } catch (e) { /* ignore */ }
  // create backup after successful add (don't block normal flow on backup failure)
  try { await createBackup(); } catch (e) { /* handled inside createBackup */ }
  return out;
}

async function listRecords() {
  await ensureConnection();
  const docs = await collection.find({}).toArray();
  return docs.map(toPublic);
}

async function updateRecord(id, newName, newValue) {
  await ensureConnection();
  const query = getQueryFromId(id);
  const updatedAt = new Date().toISOString();
  const res = await collection.findOneAndUpdate(
    query,
    { $set: { name: newName, value: newValue, updatedAt } },
    { returnDocument: 'after' }
  );
  // guard against driver returning null
  if (!res || !res.value) return null;
  const out = toPublic(res.value);
  try { vaultEvents.emit('recordUpdated', out); } catch (e) { /* ignore */ }
  return out;
}

async function deleteRecord(id) {
  await ensureConnection();
  const query = getQueryFromId(id);
  const res = await collection.findOneAndDelete(query);
  // guard against driver returning null
  if (!res || !res.value) return null;
  const out = toPublic(res.value);
  try { vaultEvents.emit('recordDeleted', out); } catch (e) { /* ignore */ }
  // create backup after successful delete
  try { await createBackup(); } catch (e) { /* handled inside createBackup */ }
  return out;
}

module.exports = {
  init,
  close,
  addRecord,
  listRecords,
  updateRecord,
  deleteRecord
};
