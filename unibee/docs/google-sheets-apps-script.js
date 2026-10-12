/**
 * UniBee → Google Sheet connector.
 *
 * 1. Create a Google Sheet (e.g. "UniBee Registrations").
 * 2. Extensions → Apps Script. Delete the sample code and paste this whole file.
 * 3. Change SECRET below to a long random string (same value as GOOGLE_SHEETS_SECRET).
 * 4. Deploy → New deployment → type "Web app".
 *      Execute as: Me    Who has access: Anyone
 * 5. Copy the Web app URL into GOOGLE_SHEETS_WEBHOOK_URL.
 *
 * The website appends one row per registration (headers are created automatically)
 * and the /admin page reads the rows back using the same secret.
 */
const SECRET = "CHANGE-ME-to-the-same-value-as-GOOGLE_SHEETS_SECRET";
const SHEET_NAME = "Registrations";

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return json_({ ok: false, error: "unauthorized" });
    const sh = sheet_();
    const keys = body.keys;
    if (sh.getLastRow() === 0) {
      sh.appendRow(body.columns); // human-readable headers
      sh.appendRow(keys); // machine keys (row 2) used by the admin page
      sh.hideRows(2);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, keys.length).setFontWeight("bold");
    }
    // Prefix with ' so values like "+880..." aren't treated as formulas
    sh.appendRow(keys.map((k) => {
      const v = body.record[k] == null ? "" : String(body.record[k]);
      return /^[=+\-@]/.test(v) ? "'" + v : v;
    }));
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  if (e.parameter.secret !== SECRET) return json_({ ok: false, error: "unauthorized" });
  const sh = sheet_();
  if (sh.getLastRow() < 3) return json_({ ok: true, rows: [] });
  const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  const keys = values[1];
  const rows = values.slice(2).map((r) => {
    const o = {};
    keys.forEach((k, i) => (o[k] = String(r[i]).replace(/^'/, "")));
    return o;
  });
  return json_({ ok: true, rows: rows });
}
