"""FastAPI app. Run with:  uvicorn app.main:app --reload   then open http://localhost:8000/docs"""
import os
import re
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy import case
from sqlmodel import Session, func, select

from .auth import create_token, get_current_user, hash_password, require_admin, verify_password
from .dashboard import build_dashboard
from .db import create_tables, engine, get_session
from .excel_export import build_workbook
from .excel_import import parse_workbook, period_label, workbook_grid
from .importer import TABLES, VISIBLE, commit_import, delete_period, delete_upload, plan_import
from .models import CustomField, Order, Quotation, StoredFile, Upload, User, UserPublic
from .records import FIELD_TYPES, check_label, custom_fields, custom_fields_for_import, delete_field, rename_field, save


def create_first_admin():
    """On a fresh server there's no terminal to run create_user, so the first admin can come from
    the ADMIN_USERNAME / ADMIN_PASSWORD settings. Only used while there are no users at all."""
    username, password = os.getenv("ADMIN_USERNAME"), os.getenv("ADMIN_PASSWORD")
    if not (username and password):
        return
    with Session(engine) as session:
        if session.exec(select(User)).first():
            return
        session.add(User(username=username.strip().lower(), full_name=os.getenv("ADMIN_NAME", "Administrator"),
                         role="admin", password_hash=hash_password(password)))
        session.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    create_first_admin()
    yield


app = FastAPI(title="Siddhivinayak CRM API", lifespan=lifespan)

# The Angular dev server runs on a different port, so the browser needs permission to call us.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- auth ----------

@app.post("/api/auth/login")
def login(form: OAuth2PasswordRequestForm = Depends(), session: Session = Depends(get_session)):
    username = form.username.strip().lower()
    user = session.exec(select(User).where(User.username == username)).first()
    # Same message whether the username or the password is wrong, so nobody can probe for usernames.
    if not user or not user.is_active or not verify_password(form.password, user.password_hash):
        raise HTTPException(401, "Wrong username or password")
    return {"access_token": create_token(user), "token_type": "bearer",
            "user": UserPublic.model_validate(user)}


@app.get("/api/auth/me", response_model=UserPublic)
def me(user: User = Depends(get_current_user)):
    return user


# ---------- users (admin only) ----------

class UserCreate(BaseModel):
    username: str
    full_name: str
    password: str
    role: str = "viewer"


class UserUpdate(BaseModel):
    full_name: str | None = None
    role: str | None = None
    is_active: bool | None = None
    password: str | None = None


def check_role_and_password(role: str | None, password: str | None):
    if role is not None and role not in ("admin", "viewer"):
        raise HTTPException(400, "Role must be admin or viewer")
    if password is not None and len(password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")


@app.get("/api/users", response_model=list[UserPublic], dependencies=[Depends(require_admin)])
def list_users(session: Session = Depends(get_session)):
    return session.exec(select(User).order_by(User.username)).all()


@app.post("/api/users", response_model=UserPublic, dependencies=[Depends(require_admin)])
def create_user(body: UserCreate, session: Session = Depends(get_session)):
    check_role_and_password(body.role, body.password)
    username = body.username.strip().lower()
    if session.exec(select(User).where(User.username == username)).first():
        raise HTTPException(400, f"Username {username!r} is already taken")
    user = User(username=username, full_name=body.full_name.strip(), role=body.role,
                password_hash=hash_password(body.password))
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@app.patch("/api/users/{user_id}", response_model=UserPublic)
def update_user(user_id: int, body: UserUpdate, admin: User = Depends(require_admin),
                session: Session = Depends(get_session)):
    check_role_and_password(body.role, body.password)
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if user.id == admin.id and (body.is_active is False or body.role == "viewer"):
        raise HTTPException(400, "You can't deactivate or demote yourself")
    if body.full_name is not None:
        user.full_name = body.full_name.strip()
    if body.role is not None:
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.password is not None:
        user.password_hash = hash_password(body.password)
    session.commit()
    session.refresh(user)
    return user


# ---------- data ----------

# Vercel refuses requests over 4.5 MB, so stay under that. The client's sheets are a few KB.
MAX_UPLOAD_MB = 4
# Older uploads kept their file in this folder. New ones are stored in the database (StoredFile).
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))


async def read_and_plan(file: UploadFile, session: Session):
    """Checks shared by preview and import: file type, size, readable workbook, at least one known sheet."""
    if not (file.filename or "").lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Please upload an Excel .xlsx file")
    content = await file.read()
    if not content:
        raise HTTPException(400, "The file is empty")
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"The file is larger than {MAX_UPLOAD_MB} MB")
    try:
        sheets = parse_workbook(content, custom_fields_for_import(session))
    except Exception:
        raise HTTPException(400, "Could not read this file as an Excel workbook. Is it password-protected or damaged?")
    if not any(s.kind for s in sheets):
        raise HTTPException(400, "No PO summary or quotation sheet found in this file. Check the column headers.")
    return plan_import(session, sheets), content


def plan_response(plans) -> dict:
    sheets = [p.summary() for p in plans]
    importable = [s for s in sheets if s["type"] and not s["errors"]]
    return {
        "sheets": sheets,
        "can_import": bool(importable) and not any(s["errors"] for s in sheets if s["type"]),
        "total_rows": sum(s["rows"] for s in importable),
    }


@app.post("/api/upload/preview", dependencies=[Depends(require_admin)])
async def preview_upload(file: UploadFile, session: Session = Depends(get_session)):
    """Dry run: shows what importing this file would do. Nothing is saved."""
    plans, _ = await read_and_plan(file, session)
    return plan_response(plans)


@app.post("/api/upload", dependencies=[Depends(require_admin)])
async def upload_excel(file: UploadFile, session: Session = Depends(get_session)):
    plans, content = await read_and_plan(file, session)
    result = plan_response(plans)
    if not result["can_import"]:
        raise HTTPException(400, "This file has errors. Fix them in Excel and upload again.")
    upload = commit_import(session, plans, file.filename)
    session.add(StoredFile(upload_id=upload.id, data=content))  # keep the original, to view/download later
    session.commit()
    return {"upload_id": upload.id, **result}


@app.get("/api/periods", dependencies=[Depends(get_current_user)])
def list_periods(session: Session = Depends(get_session)):
    """Months (PO sheets) and years (quotation sheets) that are loaded, newest first, with the file
    each came from. `rows` = shown rows from Excel, `manual` = rows typed into the app,
    `hidden` = older copies of orders that a later month's sheet now shows instead."""
    filenames = dict(session.exec(select(Upload.id, Upload.filename)).all())
    result = []
    for kind, table in TABLES.items():
        hidden = func.sum(case((Order.replaced_by_period.is_not(None), 1), else_=0)) if kind == "orders" else func.sum(0)
        manual = func.sum(case((table.upload_id.is_(None), 1), else_=0))
        for period, rows, hidden_rows, manual_rows, upload_id in session.exec(
            select(table.period, func.count(), hidden, manual, func.max(table.upload_id))
            .group_by(table.period).order_by(table.period.desc())
        ):
            hidden_rows, manual_rows = hidden_rows or 0, manual_rows or 0
            result.append({
                "type": kind, "period": period, "label": period_label(period),
                "rows": rows - hidden_rows - manual_rows, "hidden": hidden_rows, "manual": manual_rows,
                "upload_id": upload_id, "filename": filenames.get(upload_id),
            })
    return result


@app.get("/api/orders", response_model=list[Order], dependencies=[Depends(get_current_user)])
def list_orders(customer: str | None = None, session: Session = Depends(get_session)):
    query = select(Order).where(VISIBLE).order_by(Order.order_date.desc().nulls_last())
    if customer:
        query = query.where(Order.customer == customer)
    return session.exec(query).all()


@app.get("/api/quotations", response_model=list[Quotation], dependencies=[Depends(get_current_user)])
def list_quotations(session: Session = Depends(get_session)):
    return session.exec(select(Quotation).order_by(Quotation.work_location, Quotation.excel_row)).all()


# ---------- typing in / editing single rows (admin) ----------

def get_row(session: Session, entity: str, row_id: int):
    row = session.get(TABLES[entity], row_id)
    if not row:
        raise HTTPException(404, "Not found")
    return row


@app.post("/api/orders", response_model=Order, dependencies=[Depends(require_admin)])
def create_order(body: dict, session: Session = Depends(get_session)):
    row = save(session, "orders", body)
    session.commit()
    session.refresh(row)
    return row


@app.patch("/api/orders/{row_id}", response_model=Order, dependencies=[Depends(require_admin)])
def update_order(row_id: int, body: dict, session: Session = Depends(get_session)):
    row = save(session, "orders", body, get_row(session, "orders", row_id))
    session.commit()
    session.refresh(row)
    return row


@app.post("/api/quotations", response_model=Quotation, dependencies=[Depends(require_admin)])
def create_quotation(body: dict, session: Session = Depends(get_session)):
    row = save(session, "quotations", body)
    session.commit()
    session.refresh(row)
    return row


@app.patch("/api/quotations/{row_id}", response_model=Quotation, dependencies=[Depends(require_admin)])
def update_quotation(row_id: int, body: dict, session: Session = Depends(get_session)):
    row = save(session, "quotations", body, get_row(session, "quotations", row_id))
    session.commit()
    session.refresh(row)
    return row


# Two explicit paths, not "/api/{entity}/{row_id}": that pattern would also catch
# DELETE /api/uploads/3 and /api/fields/3, because it's declared before those routes.
@app.delete("/api/orders/{row_id}", dependencies=[Depends(require_admin)])
def delete_order(row_id: int, session: Session = Depends(get_session)):
    return delete_row(session, "orders", row_id)


@app.delete("/api/quotations/{row_id}", dependencies=[Depends(require_admin)])
def delete_quotation(row_id: int, session: Session = Depends(get_session)):
    return delete_row(session, "quotations", row_id)


def delete_row(session: Session, entity: str, row_id: int):
    row = get_row(session, entity, row_id)
    session.delete(row)
    session.commit()
    return {"deleted": row_id, "from_excel": row.upload_id is not None}


# ---------- custom columns ----------

class FieldCreate(BaseModel):
    entity: str
    label: str
    type: str = "text"


class FieldUpdate(BaseModel):
    label: str


@app.get("/api/fields", response_model=list[CustomField], dependencies=[Depends(get_current_user)])
def list_fields(session: Session = Depends(get_session)):
    return custom_fields(session)


@app.post("/api/fields", response_model=CustomField, dependencies=[Depends(require_admin)])
def create_field(body: FieldCreate, session: Session = Depends(get_session)):
    if body.entity not in TABLES:
        raise HTTPException(400, "entity must be orders or quotations")
    if body.type not in FIELD_TYPES:
        raise HTTPException(400, f"type must be one of: {', '.join(FIELD_TYPES)}")
    label, key = check_label(session, body.entity, body.label)
    position = len(custom_fields(session, body.entity))
    field = CustomField(entity=body.entity, key=key, label=label, type=body.type, position=position)
    session.add(field)
    session.commit()
    session.refresh(field)
    return field


@app.patch("/api/fields/{field_id}", response_model=CustomField, dependencies=[Depends(require_admin)])
def update_field(field_id: int, body: FieldUpdate, session: Session = Depends(get_session)):
    field = session.get(CustomField, field_id)
    if not field:
        raise HTTPException(404, "Column not found")
    rename_field(session, field, body.label)
    session.commit()
    session.refresh(field)
    return field


@app.delete("/api/fields/{field_id}", dependencies=[Depends(require_admin)])
def remove_field(field_id: int, session: Session = Depends(get_session)):
    field = session.get(CustomField, field_id)
    if not field:
        raise HTTPException(404, "Column not found")
    rows = delete_field(session, field)
    session.commit()
    return {"deleted": field_id, "values_removed": rows}


# ---------- export (backup) ----------

@app.get("/api/export", dependencies=[Depends(get_current_user)])
def export_excel(entity: str = "all", session: Session = Depends(get_session)):
    """Excel backup in the client's own layout: one sheet per month / quotation year.
    Uploading this file again restores the data."""
    if entity not in ("orders", "quotations", "all"):
        raise HTTPException(400, "entity must be orders, quotations or all")
    sheets = []
    if entity in ("orders", "all"):
        orders = session.exec(select(Order).where(VISIBLE).order_by(Order.period, Order.order_date, Order.id)).all()
        for period in sorted({o.period for o in orders}, key=lambda p: p or ""):
            sheets.append(("orders", period, [o for o in orders if o.period == period]))
    if entity in ("quotations", "all"):
        quotes = session.exec(select(Quotation).order_by(Quotation.period, Quotation.work_location, Quotation.id)).all()
        for period in sorted({q.period for q in quotes}, key=lambda p: p or ""):
            sheets.append(("quotations", period, [q for q in quotes if q.period == period]))
    fields = {e: custom_fields(session, e) for e in TABLES}
    content = build_workbook(sheets, fields)
    name = {"orders": "Orders", "quotations": "Quotations", "all": "Backup"}[entity]
    filename = f"Siddhivinayak_{name}_{date.today():%d-%m-%Y}.xlsx"
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/uploads", dependencies=[Depends(get_current_user)])
def list_uploads(session: Session = Depends(get_session)):
    """Uploaded files, newest first, with which months/years of data each one still provides."""
    uploads = session.exec(select(Upload).order_by(Upload.uploaded_at.desc())).all()
    in_database = set(session.exec(select(StoredFile.upload_id)).all())  # ids only, not the file bytes
    contains = {u.id: [] for u in uploads}
    for kind, table in TABLES.items():
        for upload_id, period, rows in session.exec(
            select(table.upload_id, table.period, func.count()).group_by(table.upload_id, table.period).order_by(table.period)
        ):
            contains.setdefault(upload_id, []).append({"type": kind, "period": period, "label": period_label(period), "rows": rows})
    return [
        {**u.model_dump(mode="json", exclude={"stored_file"}),
         "has_file": u.id in in_database or legacy_file(u) is not None, "periods": contains[u.id]}
        for u in uploads
    ]


def legacy_file(upload: Upload) -> Path | None:
    """Where an older upload's file was kept on disk, if it's still there."""
    path = UPLOAD_DIR / upload.stored_file if upload.stored_file else None
    return path if path and path.is_file() else None


def file_bytes(session: Session, upload: Upload) -> bytes | None:
    stored = session.get(StoredFile, upload.id)
    if stored:
        return stored.data
    path = legacy_file(upload)
    return path.read_bytes() if path else None


def get_upload(session: Session, upload_id: int) -> Upload:
    upload = session.get(Upload, upload_id)
    if not upload:
        raise HTTPException(404, "Upload not found")
    return upload


@app.get("/api/uploads/{upload_id}/view", dependencies=[Depends(get_current_user)])
def view_upload(upload_id: int, session: Session = Depends(get_session)):
    """The uploaded workbook's data, sheet by sheet, for showing it in the browser like Excel."""
    upload = get_upload(session, upload_id)
    content = file_bytes(session, upload)
    if content is None:
        raise HTTPException(404, "The original file wasn't kept for this upload (it was uploaded before files were stored).")
    sheets = workbook_grid(content)
    kinds = {s.sheet_name: s for s in parse_workbook(content)}
    for sheet in sheets:
        parsed = kinds.get(sheet["name"])
        sheet["type"] = parsed.kind if parsed else None
        sheet["period_label"] = period_label(parsed.period) if parsed and parsed.kind else None
    return {"id": upload.id, "filename": upload.filename, "sheets": sheets}


@app.get("/api/uploads/{upload_id}/file", dependencies=[Depends(get_current_user)])
def download_upload(upload_id: int, session: Session = Depends(get_session)):
    upload = get_upload(session, upload_id)
    content = file_bytes(session, upload)
    if content is None:
        raise HTTPException(404, "The original file wasn't kept for this upload.")
    safe_name = re.sub(r'[^\w.\- ]', "_", upload.filename)
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{safe_name}"'})


# Deleting: `dry_run=true` returns exactly what would be removed and saves nothing, for the confirm box.

@app.delete("/api/periods/{kind}/{period}", dependencies=[Depends(require_admin)])
def remove_period(kind: str, period: str, dry_run: bool = False, session: Session = Depends(get_session)):
    if kind not in TABLES:
        raise HTTPException(404, "Unknown data type")
    result = delete_period(session, kind, period)
    if not result["rows"]:
        raise HTTPException(404, f"No data loaded for {result['label']}")
    if dry_run:
        session.rollback()
    else:
        session.commit()
    return {"deleted": [result], "dry_run": dry_run}


@app.delete("/api/uploads/{upload_id}", dependencies=[Depends(require_admin)])
def remove_upload(upload_id: int, dry_run: bool = False, session: Session = Depends(get_session)):
    upload = get_upload(session, upload_id)
    old_path = legacy_file(upload)
    had_file = session.get(StoredFile, upload.id) is not None or old_path is not None
    deleted = delete_upload(session, upload)  # also deletes its StoredFile
    if dry_run:
        session.rollback()
    else:
        session.commit()
        if old_path:
            old_path.unlink(missing_ok=True)
    return {"deleted": deleted, "file_deleted": had_file, "dry_run": dry_run}


@app.get("/api/dashboard", dependencies=[Depends(get_current_user)])
def dashboard(session: Session = Depends(get_session)):
    return build_dashboard(session)


# ---------- the Angular app ----------
# In production the built frontend (frontend/dist/crm-admin/browser) is served from here too, so the
# whole app is one service on one address. Any path that isn't a file gets index.html, and Angular's
# router shows the right page (/orders, /data, ...).
STATIC_DIR = Path(os.getenv("STATIC_DIR", "../frontend/dist/crm-admin/browser")).resolve()

if STATIC_DIR.is_dir():
    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        file = (STATIC_DIR / path).resolve()
        if path and file.is_file() and STATIC_DIR in file.parents:  # never serve files outside STATIC_DIR
            return FileResponse(file)
        return FileResponse(STATIC_DIR / "index.html")
