# Siddhivinayak CRM (prototype)

Upload the client's Excel sheets (PO summary, quotations) → cleaned and stored in a database → shown on an admin dashboard.

| Part | Tech | Folder |
|---|---|---|
| Backend API | Python, FastAPI, SQLModel, pandas, SQLite | `backend/` |
| Frontend | Angular 22, Tailwind CSS v4, Chart.js | `frontend/` |

## First-time setup

```bash
# backend
cd backend
python3.12 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python -m app.create_user admin "Your Name" --role admin   # asks for a password

# frontend (needs Node 20+; run `nvm alias default system` if nvm still points at Node 14)
cd ../frontend
npm install
```

## Run (two terminals)

```bash
cd backend && source venv/bin/activate && uvicorn app.main:app --reload   # API on :8000, docs at /docs
cd frontend && npm start                                                    # app on http://localhost:4200
```

The Angular dev server forwards `/api/*` to the backend (`frontend/proxy.conf.json`).

## Tests

```bash
cd backend && pytest -v
```

## Where things are

**Backend** (`backend/app/`)
- `excel_import.py`: reads each sheet's Excel Table, detects the sheet type and month, cleans and converts values
- `importer.py`: plans an upload (new month / replace / carried-over rows) and commits it
- `models.py`: database tables (User, Upload, Order, Quotation)
- `auth.py`: password hashing (scrypt), JWT login tokens, `require_admin`
- `main.py`: API routes
- `dashboard.py`: the SQL behind the dashboard numbers

**Frontend** (`frontend/src/`)
- `styles.css`: design tokens (`@theme`) and shared component classes
- `app/core/`: API service, auth service, route guards, HTTP interceptor
- `app/layout/shell.*`: sidebar layout
- `app/pages/*`: login, dashboard, orders, quotations, users
- `app/shared/upload-modal.*`: the upload window (browser checks → server preview → import)
- `app/shared/`: bar chart, rupee pipe, status chip helpers

## Roles

- **admin**: everything, plus uploading Excel files and managing users
- **viewer**: read-only dashboard, orders and quotations

## Before going to production

- Set `SECRET_KEY` (long random string) and `DATABASE_URL` (PostgreSQL) environment variables
- Store money as `Decimal`/`Numeric` once on PostgreSQL
- Serve over HTTPS; consider httpOnly cookies instead of localStorage for the token; add login rate limiting

## Monthly uploads

Each PO summary sheet is one month, detected from the sheet name (`JUNE - 2026`, `Jun-26`, `2026-06`…) or, failing that, from its dates.

- A new month is added; other months are untouched.
- Uploading a month again replaces that month.
- An order repeated in a later month's sheet (same invoice, or same PO + description) replaces the earlier copy, so totals never double. Re-uploading an older month never overwrites newer data.
- The upload window shows a dry-run preview of all this before anything is saved.

## Viewing and deleting data (Data files page)

- Every uploaded file is kept in `backend/uploads/` so it can be viewed in the browser or downloaded again.
- **Delete month** removes one month's orders (or one year's quotations). **Delete file** removes every month that file provides, plus the stored file.
- When a later month replaces an order from an earlier month, the earlier copy is hidden, not deleted (`replaced_by_period`). Deleting the later month shows it again.
- Each delete first does a dry run (`?dry_run=true`) so the confirm box says exactly what will change.

## Deploying

The `Dockerfile` builds one image: FastAPI serves the API **and** the built Angular app on one address.
Everything that must survive restarts is in `/data` (`crm.db` + `uploads/`), so give the service a persistent disk mounted at `/data`.

| Setting | Value |
|---|---|
| `SECRET_KEY` | **Required.** Long random string: `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Creates the first admin on the first start (only when there are no users yet) |
| `PORT` | Set automatically by most hosts (default 8000) |

Try it locally:

```bash
docker build -t siddhivinayak-crm .
docker run -p 8090:8000 -v crm-data:/data -e SECRET_KEY=change-me-to-something-long \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=choose-a-password siddhivinayak-crm
# open http://localhost:8090
```

On Railway: `railway login`, `railway init`, `railway up`, then add a Volume mounted at `/data`, set the variables above, and generate a public domain.

## Entering data, custom columns and export

- **New order / New quotation** (admins) add rows directly. They're stored with `upload_id = NULL` and are never replaced or deleted by Excel uploads or "Delete month". Editing a row that came from Excel works too, but re-uploading its month brings back the Excel version.
- **Columns** (admins) adds extra columns (text, number, date, yes/no). Values are stored in each row's `extra` JSON. An Excel column with the same name (e.g. `SITE ENGINEER`) is imported into it.
- **Export Excel** (Orders/Quotations pages) and **Download full backup** (Data files) produce a workbook in the client's own layout, one sheet per month / quotation year. Uploading it restores the data (tested in `test_export_is_a_backup_that_can_be_uploaded_again`).

## Free hosting: Vercel + Neon

Vercel hosts the Angular site and runs FastAPI as a serverless function (`api/index.py`, routed by `vercel.json`).
Serverless functions have no lasting disk, so the database is **Neon** (free PostgreSQL) and uploaded Excel files are stored in the database (`StoredFile`).

1. **Neon** (neon.tech): create a free project, copy the connection string.
2. **Copy your data** from `crm.db` into it:
   `cd backend && venv/bin/python -m app.copy_data "postgresql://...neon.tech/neondb?sslmode=require"`
3. **Vercel**: `npm i -g vercel`, `vercel login`, then in the project folder `vercel` (creates the project).
4. Add environment variables (Production): `DATABASE_URL` (the Neon string), `SECRET_KEY` (long random), `REQUIRE_SECRET_KEY=1`.
5. `vercel --prod` deploys. Re-run it after every change.

Local development is unchanged (SQLite). To run the tests against PostgreSQL: `TEST_DATABASE_URL=postgresql://... pytest`.
# crm-monika
