# Woodhouse party enquiries

A simple page that shows every birthday party enquiry from the Google Form as an
easy-to-read card. Click **Edit** on a card to change anything (including a
**Status** and **Notes**), and the change is saved straight into the Google Sheet.

- Search box and a status filter at the top
- Tap a phone number to call, or an email to write
- Protected by a team password

It runs on Cloudflare Workers (free plan is fine). No database is needed: the
Google Sheet is the only place the data lives.

## Setup

### 1. Check the sheet ID

In `wrangler.jsonc`, `SHEET_ID` must be the sheet the form saves to: the part
of the sheet's web address between `/d/` and `/edit`. `SHEET_TAB` is the tab
name (`Form Responses 1`).

### 2. Deploy on Cloudflare

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Pick this repo, branch `main`.
3. Leave the build command empty and the deploy command as `npx wrangler deploy`.
4. **Create and deploy**.

### 3. Set the password

Worker → **Settings → Variables and Secrets** → **Add**, type **Secret**:

| Name | Value |
| --- | --- |
| `DASHBOARD_PASSWORD` | the password staff type to sign in |
| `SESSION_SECRET` | any long random text (30+ characters) |

At this point the page works in **read-only** mode, as long as the sheet is
shared as "Anyone with the link can view".

### 4. Turn on editing (Google "robot" account)

1. Go to **console.cloud.google.com** → create a project.
2. Search **Google Sheets API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account**
   → give it a name → **Done**.
4. Click the new service account → copy its email (ends in
   `iam.gserviceaccount.com`).
5. **Keys** tab → **Add key → Create new key → JSON**. A file downloads.
6. In the Google Sheet → **Share** → paste that email → set it to **Editor** →
   untick "Notify people" → **Share**.
7. Open the downloaded file in Notepad/TextEdit, copy everything, and add it in
   Cloudflare as a **Secret** named `GOOGLE_SERVICE_ACCOUNT_JSON`.
8. Optional but recommended: set the sheet's **General access** back to
   **Restricted**. The dashboard keeps working through the robot account.

## Good to know

- **Status and Notes columns:** the first time you save a status or note, the
  dashboard turns the sheet's spare `Column 1` into **Notes** (it already holds
  notes like "emailed 29/8/25") and the next empty spare column into **Status**.
  You can also type in those columns directly in the sheet.
- **Saving is safe if rows move:** each save checks the row's form timestamp, so
  sorting or deleting rows in the sheet won't make an edit land on the wrong
  enquiry. The timestamp itself can't be edited.
- **Refresh:** the page reads the sheet at most once a minute; the **Refresh**
  button reads it immediately.
- **Changing the form:** cards use short labels matched from the question
  wording (e.g. "Star of the show" → *Birthday child*). If a question is reworded
  a lot, update `FIELDS` at the top of `src/sheet.js`.

## Files

| Path | What it is |
| --- | --- |
| `src/worker.js` | Login and the read/save API |
| `src/sheet.js` | Reads and writes the Google Sheet |
| `src/auth.js` | Team password and sign-in cookie |
| `public/` | The page itself (plain HTML/CSS/JS) |
| `test/` | Tests (`npm test`) |

Local testing: `cp .dev.vars.example .dev.vars`, fill it in, then `npm run dev`.
