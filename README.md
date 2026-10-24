# HMIS — Hotel Maintenance Inventory System (prototype, dummy data only)

HMIS is the application name; the Google Sheet tabs keep their fixed names `Balance`, `In`, `Out`, `Users`, `AuditLog`. Setup saves the spreadsheet ID in Script Property `HMIS_SPREADSHEET_ID`.

Structure: `Code.gs` + `appsscript.json` (Apps Script backend) and `docs/` (static frontend for GitHub Pages: `index.html`, `styles.css`, `app.js`, `config.js`).
GitHub Pages cannot use Apps Script `include()` templates, so the frontend is plain static files instead of `Index.html/Styles.html/JavaScript.html`.

## Deploy backend
1. Create a new Google Sheet (leave it empty). Extensions → Apps Script.
2. Paste `Code.gs`; replace the manifest (Project Settings → show `appsscript.json`) with the one here.
3. Select `setupHMIS` → Run → authorize. Open **Execution log**: it prints the sheet URL and the **demo PINs (shown once)** for ADMIN01, TECH01, FIN01. Re-running is safe: existing sheets/rows are never overwritten; demo data is only added to empty Balance/Users.
4. Deploy → New deployment → Web app → Execute as **Me**, Access **Anyone** → copy the `/exec` URL.
   After any code change, create a *new version* of the deployment.

## Deploy frontend
1. Put the repo on GitHub; Settings → Pages → deploy from branch, folder `/docs`.
2. Edit `docs/config.js` and set `API_URL` to the `/exec` URL. (Not a secret; every request needs staff ID + PIN.)
3. Open `https://<user>.github.io/<repo>/`.

## QR workflow
Payload = `https://<user>.github.io/<repo>/?item=HVAC-0001` (ID only, never balance). Set Script Property `FRONTEND_URL` to your Pages URL, run `listQrUrls()`, paste each URL into any QR generator and print the labels. Use **QR codes** (a plain 1D barcode holding only the ID will not open a page from a camera app).
Technicians scan with the phone's normal camera app or any scanner app; the link opens the item page directly (name, image, balance, Stock In / Stock Out). No camera permission is needed by HMIS because HMIS does not access the camera. Staff ID + PIN are asked only on the Stock In/Out form. The in-page camera scanner was removed.

## Security model and limits
- All actions (including reads) are POST and require staff_id + PIN, verified server-side; role comes only from `Users`. Technician/administrator can write; finance is read-only. Inactive users rejected. 5 failed attempts → 15-min lockout (per staff ID, via cache).
- PINs are stored as salted **iterated HMAC-SHA256 (2000 rounds)**, never plaintext. Apps Script has no PBKDF2/bcrypt, so this is weaker than a real KDF: anyone who can read the Sheet could brute-force a 6-digit PIN offline. **Restrict Sheet access to admins.** Demo prototype only.
- PIN is kept in `sessionStorage` for the tab session and sent with each request (no session tokens yet). Use HTTPS only.
- Web app access is "Anyone" (required for GitHub Pages calls) but it only serves authenticated requests.
- Concurrency: `LockService` script lock; duplicate submits blocked by `request_id` (1h cache) and disabled button.
- Failure handling: log row is appended first, balance updated and read back; on failure the log row is deleted and an audit entry written. If rollback itself fails, `ROLLBACK_FAILED` is audited and manual reconciliation is needed. No transactional guarantee beyond this.
- Demo opening stock is recorded as `In` rows so balance = ΣIn − ΣOut.

## Testing status (honest)
Only **JavaScript syntax checks** (`node --check`) were run. Nothing was run against real Google Sheets, Apps Script, or a phone, so none of the checks below have passed yet. Please run them:
1. Run `setupHMIS` on an empty sheet → 5 sheets with exact headers, 5 demo items, 3 users, PINs in log.
2. Run it again → no duplicates; add a wrong header to a test sheet → clear error, sheet untouched.
3. Open `<pages-url>?item=HVAC-0001` in a private tab: item shows with no login. Tap Stock In, enter TECH01 + PIN, quantity 5 → balance 25, `In` row has `balance_after=25`, AuditLog has `STOCK_IN`.
4. Stock Out 2 → 23; Stock Out 999 → rejected, no row written.
5. Qty 0, −1, `abc` → rejected. Unknown item ID → "Item not found".
6. FIN01 attempts stock in → "role not allowed". Wrong PIN ×5 → lockout.
7. `HVAC-0002` (3 < min 5) shows LOW warning.
8. Scan a printed QR with the phone camera → exact item opens without login; wrong PIN on submit is rejected.

## Not implemented
Adjustments/corrections, admin UI for items/users/PIN changes (edit sheet manually; PINs must be hashed via `hashPin_`), Finance audit report view, session tokens, QR image generation, image upload.
