/**
 * HMIS — Hotel Maintenance Inventory System (PROTOTYPE, DUMMY DATA ONLY)
 * Backend: Google Apps Script Web App + Google Sheets.
 * All requests are POST (Content-Type text/plain, JSON body). Only action 'item' (single-item view) is public;
 * every other action, including all stock writes, requires staff_id + pin.
 */

// ---------- Configuration ----------
const SPREADSHEET_ID_OVERRIDE = '';   // Optional: set only if script is NOT bound to the spreadsheet.
const PIN_ITERATIONS = 2000;          // Iterated-HMAC work factor (see README limitations).
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_SECONDS = 900;
const MAX_QTY = 100000;

// ---------- Single source of truth for schema ----------
const SCHEMA = {
  Balance:  ['item_id','item_name','category','unit','balance','min_stock','location','image_url','active'],
  In:       ['transaction_id','timestamp','item_id','qty','staff_id','notes','balance_after'],
  Out:      ['transaction_id','timestamp','item_id','qty','staff_id','location_used','purpose','notes','balance_after'],
  Users:    ['staff_id','name','pin_hash','pin_salt','role','active'],
  AuditLog: ['audit_id','timestamp','staff_id','action','item_id','transaction_id','details']
};
const S = { BAL:'Balance', IN:'In', OUT:'Out', USERS:'Users', AUDIT:'AuditLog' };
const ROLES = { TECH:'technician', FIN:'finance', ADMIN:'administrator' };

// ---------- Setup ----------
function setupHMIS() {
  const ss = getSS_();
  Object.keys(SCHEMA).forEach(function (name) {
    const headers = SCHEMA[name];
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0 && sh.getLastColumn() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      validateHeaders_(sh, name); // throws if incompatible; never overwrites
    }
  });
  // Remove the default empty sheet only if it is truly empty.
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && def.getLastColumn() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  PropertiesService.getScriptProperties().setProperty('HMIS_SPREADSHEET_ID', ss.getId());

  const msgs = [];
  const bal = ss.getSheetByName(S.BAL);
  if (bal.getLastRow() <= 1) { seedDemoItems_(); msgs.push('Demo inventory added (DUMMY DATA).'); }
  const usr = ss.getSheetByName(S.USERS);
  if (usr.getLastRow() <= 1) { msgs.push(seedDemoUsers_()); }
  audit_('SYSTEM', 'SETUP', '', '', 'setupHMIS completed. ' + msgs.join(' '));
  Logger.log('HMIS — Hotel Maintenance Inventory System: setup OK.\nSpreadsheet: ' + ss.getUrl() + '\n' + msgs.join('\n'));
}

function seedDemoItems_() {
  const items = [
    ['HVAC-0001','Capacitor 2.5µF','HVAC','pcs',20,5,'DEMO Store A / Shelf 1'],
    ['HVAC-0002','Capacitor 35µF','HVAC','pcs',3,5,'DEMO Store A / Shelf 1'],
    ['PLB-0001','Flexible Hose','Plumbing','pcs',12,4,'DEMO Store B / Rack 2'],
    ['ELE-0001','Electrical Tape','Electrical','roll',30,10,'DEMO Store A / Drawer 3'],
    ['ELE-0002','Copper Wire 2.5mm','Electrical','meter',100,50,'DEMO Store C / Reel 1']
  ];
  const now = new Date();
  items.forEach(function (it, i) {
    appendObj_(S.BAL, { item_id:it[0], item_name:it[1], category:it[2], unit:it[3], balance:it[4],
      min_stock:it[5], location:it[6], image_url:'', active:true });
    // Opening stock is recorded as a stock-in so balance = sum(In) - sum(Out) stays reconcilable.
    appendObj_(S.IN, { transaction_id:'IN-DEMO-' + (i + 1), timestamp:now, item_id:it[0], qty:it[4],
      staff_id:'SYSTEM', notes:'DEMO opening stock (dummy data)', balance_after:it[4] });
  });
}

function seedDemoUsers_() {
  const users = [['ADMIN01','Demo Admin',ROLES.ADMIN],['TECH01','Demo Technician',ROLES.TECH],['FIN01','Demo Finance',ROLES.FIN]];
  const lines = ['DEMO users created. PINs are shown ONCE here and are not stored in plaintext:'];
  users.forEach(function (u) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    const salt = Utilities.getUuid();
    appendObj_(S.USERS, { staff_id:u[0], name:u[1], pin_hash:hashPin_(pin, salt), pin_salt:salt, role:u[2], active:true });
    lines.push('  ' + u[0] + ' (' + u[2] + ') PIN: ' + pin);
  });
  return lines.join('\n');
}

/** Run manually after setting Script Property FRONTEND_URL to print QR payload URLs. */
function listQrUrls() {
  const base = PropertiesService.getScriptProperties().getProperty('FRONTEND_URL');
  if (!base) throw new Error('Set Script Property FRONTEND_URL (your GitHub Pages URL) first.');
  readRows_(S.BAL).forEach(function (r) { Logger.log(r.item_id + '  ' + base + '?item=' + encodeURIComponent(r.item_id)); });
}

// ---------- Web app entry points ----------
function doGet() {
  return json_({ ok: true, service: 'HMIS — Hotel Maintenance Inventory System', message: 'API is up. Use POST.' });
}

function doPost(e) {
  try {
    let req;
    try { req = JSON.parse(e.postData.contents); } catch (x) { throw new HmisError('BAD_REQUEST', 'Invalid request.'); }
    // Public, read-only: ONE active item by ID (what a QR scan opens). No history, no listing, no writes.
    if (String(req.action) === 'item') return json_({ ok: true, data: getPublicItem_(req.item_id) });
    const user = authenticate_(req);
    switch (String(req.action)) {
      case 'login':   return json_({ ok: true, data: { staff_id: user.staff_id, name: user.name, role: user.role } });
      case 'list':    return json_({ ok: true, data: listItems_(req.q) });
      case 'get':     return json_({ ok: true, data: getItem_(req.item_id) });
      case 'history': return json_({ ok: true, data: getHistory_(req.type, req.item_id, req.limit) });
      case 'stockIn': requireRole_(user, [ROLES.TECH, ROLES.ADMIN]); return json_({ ok: true, data: stockIn_(user, req) });
      case 'stockOut':requireRole_(user, [ROLES.TECH, ROLES.ADMIN]); return json_({ ok: true, data: stockOut_(user, req) });
      default: throw new HmisError('BAD_REQUEST', 'Unknown action.');
    }
  } catch (err) {
    if (err instanceof HmisError) return json_({ ok: false, error: { code: err.code, message: err.message } });
    console.error(err && err.stack ? err.stack : err); // server log only
    return json_({ ok: false, error: { code: 'SERVER_ERROR', message: 'Unexpected server error. Please try again.' } });
  }
}

// ---------- Stock operations ----------
function stockIn_(user, p) {
  return applyTxn_(S.IN, user, p, function (qty, bal) { return bal + qty; }, function () {
    return { notes: clean_(p.notes, 300) };
  });
}

function stockOut_(user, p) {
  const location_used = clean_(p.location_used, 100), purpose = clean_(p.purpose, 200);
  if (!location_used) throw new HmisError('VALIDATION', 'Usage location is required.');
  if (!purpose) throw new HmisError('VALIDATION', 'Purpose is required.');
  return applyTxn_(S.OUT, user, p, function (qty, bal) {
    if (qty > bal) throw new HmisError('INSUFFICIENT_STOCK', 'Insufficient stock. Available: ' + bal + '.');
    return bal - qty;
  }, function () { return { location_used: location_used, purpose: purpose, notes: clean_(p.notes, 300) }; });
}

function applyTxn_(sheetName, user, p, calc, extraFn) {
  const qty = parseQty_(p.qty);
  const itemId = normId_(p.item_id);
  if (!itemId) throw new HmisError('VALIDATION', 'Item ID is required.');
  const reqId = String(p.request_id || '').slice(0, 64);
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new HmisError('BUSY', 'System busy. Please retry.');
  try {
    if (reqId) { const dup = cache.get('req:' + reqId); if (dup) return JSON.parse(dup); } // duplicate submit
    const item = findItem_(itemId);
    if (!item) throw new HmisError('NOT_FOUND', 'Item not found.');
    if (item.obj.active !== true) throw new HmisError('INACTIVE', 'Item is inactive.');
    const oldBal = Number(item.obj.balance);
    if (!isFinite(oldBal) || oldBal < 0) throw new HmisError('DATA_ERROR', 'Stored balance is invalid. Contact admin.');
    const newBal = round3_(calc(qty, oldBal));
    if (newBal < 0) throw new HmisError('INSUFFICIENT_STOCK', 'Balance cannot be negative.');

    const txId = (sheetName === S.IN ? 'IN-' : 'OUT-') + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHHmmss') + '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
    const rec = Object.assign({ transaction_id: txId, timestamp: new Date(), item_id: itemId, qty: qty,
      staff_id: user.staff_id, balance_after: newBal }, extraFn());

    // Safe ordering: 1) append log row  2) update balance  3) verify  (roll back log row on failure)
    const logSh = sheet_(sheetName);
    appendObj_(sheetName, rec);
    const logRow = logSh.getLastRow();
    try {
      const balSh = sheet_(S.BAL);
      balSh.getRange(item.row, colOf_(S.BAL, 'balance')).setValue(newBal);
      SpreadsheetApp.flush();
      if (Number(balSh.getRange(item.row, colOf_(S.BAL, 'balance')).getValue()) !== newBal) throw new Error('verify failed');
    } catch (e) {
      try { logSh.deleteRow(logRow); } catch (e2) { audit_(user.staff_id, 'ROLLBACK_FAILED', itemId, txId, 'Manual reconciliation needed'); }
      audit_(user.staff_id, 'TXN_FAILED', itemId, txId, 'Balance update failed; log row rolled back');
      throw new HmisError('WRITE_FAILED', 'Transaction failed and was not recorded. Please retry.');
    }
    audit_(user.staff_id, sheetName === S.IN ? 'STOCK_IN' : 'STOCK_OUT', itemId, txId, 'qty=' + qty + ' balance ' + oldBal + '->' + newBal);
    const result = { transaction_id: txId, item_id: itemId, qty: qty, balance_after: newBal };
    if (reqId) cache.put('req:' + reqId, JSON.stringify(result), 3600);
    return result;
  } finally { lock.releaseLock(); }
}

// ---------- Queries ----------
function listItems_(q) {
  const needle = String(q || '').trim().toLowerCase();
  return readRows_(S.BAL).filter(function (r) {
    return r.active === true && (!needle || String(r.item_id).toLowerCase().indexOf(needle) >= 0 || String(r.item_name).toLowerCase().indexOf(needle) >= 0);
  }).map(publicItem_);
}

function getItem_(id) {
  const it = findItem_(normId_(id));
  if (!it) throw new HmisError('NOT_FOUND', 'Item not found.');
  return publicItem_(it.obj);
}

function getPublicItem_(id) {
  const it = findItem_(normId_(id));
  if (!it || it.obj.active !== true) throw new HmisError('NOT_FOUND', 'Item not found.');
  return publicItem_(it.obj);
}

function getHistory_(type, id, limit) {
  const sheetName = type === 'in' ? S.IN : type === 'out' ? S.OUT : null;
  if (!sheetName) throw new HmisError('BAD_REQUEST', 'type must be "in" or "out".');
  const itemId = normId_(id);
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const rows = readRows_(sheetName).filter(function (r) { return !itemId || r.item_id === itemId; });
  return rows.slice(-n).reverse().map(function (r) { r.timestamp = r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp); return r; });
}

function publicItem_(r) {
  const bal = Number(r.balance), min = Number(r.min_stock);
  const img = String(r.image_url || '');
  return { item_id: r.item_id, item_name: r.item_name, category: r.category, unit: r.unit, balance: bal,
    min_stock: min, location: r.location, image_url: /^https:\/\//.test(img) ? img : '', low_stock: bal <= min };
}

// ---------- Auth ----------
function authenticate_(req) {
  const id = normId_(req.staff_id), pin = String(req.pin || '');
  if (!id || !pin) throw new HmisError('AUTH', 'Staff ID and PIN are required.');
  const cache = CacheService.getScriptCache(), key = 'fail:' + id;
  if (Number(cache.get(key) || 0) >= MAX_FAILED_LOGINS) throw new HmisError('LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
  const u = readRows_(S.USERS).filter(function (r) { return r.staff_id === id; })[0];
  const ok = u && u.active === true && safeEq_(hashPin_(pin, String(u.pin_salt)), String(u.pin_hash));
  if (!ok) {
    cache.put(key, String(Number(cache.get(key) || 0) + 1), LOCKOUT_SECONDS);
    audit_(id, 'LOGIN_FAILED', '', '', '');
    throw new HmisError('AUTH', 'Invalid staff ID or PIN.');
  }
  cache.remove(key);
  return { staff_id: u.staff_id, name: u.name, role: u.role }; // role comes ONLY from the Users sheet
}

function requireRole_(user, allowed) {
  if (allowed.indexOf(user.role) < 0) throw new HmisError('FORBIDDEN', 'Your role is not allowed to do this.');
}

/** Iterated HMAC-SHA256 keyed by the PIN. NOT true PBKDF2 (unavailable in Apps Script); see README. */
function hashPin_(pin, salt) {
  // Apps Script requires BOTH arguments to be byte[] (or both strings); mixing types throws.
  const key = Utilities.newBlob(String(pin)).getBytes();
  let u = Utilities.computeHmacSha256Signature(Utilities.newBlob(String(salt)).getBytes(), key);
  for (let i = 1; i < PIN_ITERATIONS; i++) u = Utilities.computeHmacSha256Signature(u, key);
  return Utilities.base64Encode(u);
}
function safeEq_(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

// ---------- Sheet helpers (all driven by SCHEMA) ----------
function getSS_() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  try {
    if (SPREADSHEET_ID_OVERRIDE) ss = SpreadsheetApp.openById(SPREADSHEET_ID_OVERRIDE);
    else { ss = SpreadsheetApp.getActiveSpreadsheet(); var sid = props.getProperty('HMIS_SPREADSHEET_ID') || props.getProperty('SPREADSHEET_ID'); /* legacy key fallback */ if (!ss && sid) ss = SpreadsheetApp.openById(sid); }
  } catch (e) { ss = null; }
  if (!ss) throw new Error('No spreadsheet available. Bind the script to a Sheet or set SPREADSHEET_ID_OVERRIDE.');
  return ss;
}
function sheet_(name) {
  const sh = getSS_().getSheetByName(name);
  if (!sh) throw new HmisError('DATA_ERROR', 'Database not set up. Run setupHMIS().');
  return sh;
}
function validateHeaders_(sh, name) {
  const expected = SCHEMA[name];
  const actual = sh.getRange(1, 1, 1, expected.length).getValues()[0].map(String);
  const bad = expected.filter(function (h, i) { return actual[i] !== h; });
  if (bad.length) throw new Error('Sheet "' + name + '" has incompatible headers. Expected: ' + expected.join(' | ') + ' but found: ' + actual.join(' | ') + '. Not modified.');
}
function colOf_(name, header) { return SCHEMA[name].indexOf(header) + 1; }
function readRows_(name) {
  const sh = sheet_(name), h = SCHEMA[name];
  validateHeaders_(sh, name);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues().map(function (row, i) {
    const o = { _row: i + 2 }; h.forEach(function (k, c) { o[k] = row[c]; }); 
    if (o.active !== undefined) o.active = (o.active === true || String(o.active).toUpperCase() === 'TRUE');
    return o;
  });
}
function appendObj_(name, obj) {
  sheet_(name).appendRow(SCHEMA[name].map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}
function findItem_(id) {
  const r = readRows_(S.BAL).filter(function (x) { return x.item_id === id; })[0];
  return r ? { row: r._row, obj: r } : null;
}
function audit_(staff, action, itemId, txId, details) {
  try {
    appendObj_(S.AUDIT, { audit_id: 'AUD-' + Utilities.getUuid(), timestamp: new Date(), staff_id: staff, action: action,
      item_id: itemId || '', transaction_id: txId || '', details: details || '' });
  } catch (e) { console.error('audit failed', e); }
}

// ---------- Utilities ----------
function HmisError(code, message) { this.code = code; this.message = message; }
HmisError.prototype = Object.create(Error.prototype);
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function normId_(v) { return String(v || '').trim().toUpperCase().slice(0, 40); }
function clean_(v, max) { return String(v || '').trim().replace(/[\r\n]+/g, ' ').replace(/^[=+\-@]/, "'$&").slice(0, max); } // blocks formula injection
function round3_(n) { return Math.round(n * 1000) / 1000; }
function parseQty_(v) {
  const n = typeof v === 'number' ? v : Number(String(v || '').trim());
  if (!isFinite(n) || n <= 0) throw new HmisError('VALIDATION', 'Quantity must be a number greater than zero.');
  if (n > MAX_QTY) throw new HmisError('VALIDATION', 'Quantity is too large.');
  return round3_(n);
}
