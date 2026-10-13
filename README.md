# Woodhouse party enquiries

A small dashboard for managing birthday party enquiries that come in through the
Woodhouse Google Form. It reads the form responses straight from the Google Sheet
and lets the team:

- see what needs a reply, which follow-ups are due, and which parties are coming up
- search and filter by status, package and date, and export to CSV
- open an enquiry to call, text or email the family in one tap
- set a status (New → Contacted → Quoted → Booked → Completed, or Not going ahead),
  a confirmed party date, a follow-up date, the quote and notes
- log calls, emails and deposits, with a timeline of who did what

The Google Sheet is **never modified**. Everything the team adds lives in a
Cloudflare D1 database, linked to each form response.

It runs as a single Cloudflare Worker (static files + a small API) behind a team
password.

## How it fits together

```
Google Form ──> Google Sheet ("Form Responses 1")
                      │  read-only, cached 60s
                      ▼
        Cloudflare Worker (src/worker.js) ──> D1 database (status, notes, activity)
                      │
                      ▼
          Dashboard (public/index.html + app.js)
```

| Path | What it is |
| --- | --- |
| `src/worker.js` | Login, API routes, merges sheet rows with saved status/notes |
| `src/sheet.js` | Reads the sheet and turns free-text answers (dates like "16th of November", "18/10/25") into usable data |
| `src/auth.js` | Shared-password login with a signed cookie |
| `public/` | The dashboard UI (plain HTML/CSS/JS, no build step) |
| `migrations/` | D1 database tables |
| `test/` | Tests for the sheet parsing (`npm test`) |

## Deploying to Cloudflare

You need Node.js 20+ and a Cloudflare account.

### 1. Create the database

```bash
npm install
npx wrangler login
npx wrangler d1 create woodhouse-enquiries
```

Copy the `database_id` it prints into `wrangler.jsonc` (replace
`REPLACE_WITH_YOUR_D1_DATABASE_ID`), then commit and push that change.

### 2. Point it at the right sheet

`wrangler.jsonc` has `SHEET_ID` set to the sheet you shared
(`Copy of Woodhouse Birthday Party Enquiry (Responses)`). If the form actually
writes to a different sheet, change `SHEET_ID` to that sheet's ID (the long part
of its URL between `/d/` and `/edit`) so new enquiries show up. `SHEET_TAB` is
the tab name, `Form Responses 1` by default.

### 3. Give the Worker access to the sheet

The sheet contains families' names, phone numbers and emails, so the recommended
setup is a Google service account that can read the sheet while the sheet itself
stays private.

**Recommended: service account**

1. In [Google Cloud Console](https://console.cloud.google.com/) create (or pick) a project.
2. Enable the **Google Sheets API** (APIs & Services → Library).
3. APIs & Services → Credentials → Create credentials → **Service account**. No roles are needed.
4. Open the service account → Keys → Add key → JSON. A `.json` file downloads.
5. In the Google Sheet, click **Share** and add the service account's email
   (`…@….iam.gserviceaccount.com`) as a **Viewer**.
6. Save the key as a secret (paste the whole file contents when prompted):

   ```bash
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
   ```

7. You can now change the sheet's general access back to **Restricted**.

**Quick start: link sharing**

If `GOOGLE_SERVICE_ACCOUNT_JSON` isn't set, the Worker reads the sheet's public
CSV export. That only works while the sheet is shared as "Anyone with the link
can view", which means anyone with the link can see the customer details. Fine
for trying it out; switch to the service account before relying on it.

### 4. Set the team password

```bash
npx wrangler secret put DASHBOARD_PASSWORD   # what staff type to sign in
npx wrangler secret put SESSION_SECRET       # any long random string, e.g. from: openssl rand -hex 32
```

Changing `SESSION_SECRET` signs everyone out.

### 5. Deploy

**From your computer:**

```bash
npm run deploy
```

This creates the database tables (if needed) and deploys. Wrangler prints the
URL, e.g. `https://woodhouse-party-enquiries.<your-subdomain>.workers.dev`.

**Or automatically on every push to GitHub:**

1. Cloudflare dashboard → **Workers & Pages** → Create → **Import a repository**
   and pick this repo.
2. Set the **Deploy command** to `npm run deploy` (so database migrations run
   too). Leave the build command empty.
3. Add `DASHBOARD_PASSWORD`, `SESSION_SECRET` and (optionally)
   `GOOGLE_SERVICE_ACCOUNT_JSON` under the Worker's **Settings → Variables and
   Secrets** as type *Secret*, if you didn't already set them with Wrangler.

To use your own domain (e.g. `parties.woodhouse.org.au`), add it under the
Worker's **Settings → Domains & Routes**.

### Extra protection (optional)

For per-person logins instead of a shared password, put the Worker behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
(free for up to 50 users) and allow your staff emails. The password screen still
applies on top.

## Running it locally

```bash
cp .dev.vars.example .dev.vars        # then edit the values
npm run db:migrate:local
npm run dev                           # http://localhost:8787
```

`npm test` runs the parsing tests.

## Good to know

- **Refreshing:** the sheet is cached for 60 seconds. "Refresh from sheet" pulls
  it immediately.
- **Party dates:** families type dates in all sorts of ways. The dashboard makes
  its best guess (preferring a date after the enquiry was sent) and shows a
  striped date tile with a `?` when it had to guess. Set **Confirmed party date**
  on the enquiry to fix it.
- **Existing sheet notes:** anything in the sheet's spare columns (like
  "emailed 29/8/25") shows on the enquiry as "Notes written in the sheet", and
  those enquiries start as *Contacted* rather than *New*.
- **Old enquiries:** "Needs attention" and "All open" hide parties whose date has
  passed. Use "Everything" to see them.
- **Changing the form:** columns are matched by the question wording
  (e.g. "Star of the show", "candles", "adventure crew"), so reordering
  questions is fine. If you reword a question substantially, update the matching
  pattern in `FIELDS` at the top of `src/sheet.js`.
