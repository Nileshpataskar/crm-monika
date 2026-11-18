"""Run with:  pytest -v
Expected numbers were checked by hand against the client's sample sheets."""
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.auth import hash_password
from app.db import engine_for, get_session
from app.main import app
from app.models import User

DATA = Path(__file__).parent.parent / "data"


@pytest.fixture
def anon(monkeypatch, tmp_path):
    """A client that is not logged in, on a fresh empty database (tests never touch crm.db).
    In-memory SQLite by default. To run every test against PostgreSQL (like Neon), set e.g.
    TEST_DATABASE_URL=postgresql://postgres:test@localhost:5433/postgres"""
    monkeypatch.setattr("app.main.UPLOAD_DIR", tmp_path)  # only older uploads keep files on disk
    if os.getenv("TEST_DATABASE_URL"):
        engine = engine_for(os.environ["TEST_DATABASE_URL"])
        SQLModel.metadata.drop_all(engine)
    else:
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(User(username="admin", full_name="Admin", role="admin", password_hash=hash_password("admin-pass")))
        session.add(User(username="viewer", full_name="Viewer", role="viewer", password_hash=hash_password("viewer-pass")))
        session.commit()

    def session_override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = session_override
    yield TestClient(app)
    app.dependency_overrides.clear()


def login(client, username, password):
    res = client.post("/api/auth/login", data={"username": username, "password": password})
    assert res.status_code == 200, res.text
    client.headers["Authorization"] = f"Bearer {res.json()['access_token']}"
    return client


@pytest.fixture
def client(anon):
    return login(anon, "admin", "admin-pass")


def upload(client, name):
    with open(DATA / name, "rb") as f:
        return client.post("/api/upload", files={"file": (name, f)})


def test_po_sheet_import(client):
    res = upload(client, "po_summary.xlsx")
    assert res.status_code == 200
    sheet = res.json()["sheets"][0]
    assert sheet["rows"] == 15  # Excel rows 2-16; totals, pivot and dropdown lists ignored
    assert sheet["warnings"] == ["Row 12: no order date (CONDENSER CELL CLEANING BRUSH)"]

    orders = client.get("/api/orders").json()
    first = next(o for o in orders if o["excel_row"] == 2)
    assert first["po_number"] == "4601545200"  # text, not 4601545200.0
    assert first["total_amount"] == 16520
    assert first["payment_received"] is True


def test_reupload_does_not_duplicate(client):
    upload(client, "po_summary.xlsx")
    upload(client, "po_summary.xlsx")
    assert len(client.get("/api/orders").json()) == 15


def test_quotation_import(client):
    res = upload(client, "quotations.xlsx")
    assert res.json()["sheets"][0]["rows"] == 12
    quotes = client.get("/api/quotations").json()
    assert {q["work_location"] for q in quotes} == {"MCD 1", "MCD 2, 3"}


def test_dashboard_totals_match_excel(client):
    upload(client, "po_summary.xlsx")
    upload(client, "quotations.xlsx")
    data = client.get("/api/dashboard").json()

    assert data["kpis"]["invoiced_total"] == 196756.46  # TOTAL cell W19 in the sheet
    assert data["kpis"]["received_total"] == 107365.56
    assert data["kpis"]["outstanding_total"] == 89390.9
    bfl = next(c for c in data["by_customer"] if c["customer"] == "BFL")
    assert bfl["outstanding"] == 63395.5
    assert data["kpis"]["won_quotes"] == 4


def test_rejects_non_excel(client):
    res = client.post("/api/upload", files={"file": ("notes.txt", b"hello")})
    assert res.status_code == 400


def test_data_requires_login(anon):
    assert anon.get("/api/dashboard").status_code == 401
    anon.headers["Authorization"] = "Bearer not-a-real-token"
    assert anon.get("/api/dashboard").status_code == 401


def test_wrong_password(anon):
    res = anon.post("/api/auth/login", data={"username": "admin", "password": "nope"})
    assert res.status_code == 401


def test_viewer_can_read_but_not_upload(anon):
    viewer = login(anon, "viewer", "viewer-pass")
    assert viewer.get("/api/dashboard").status_code == 200
    assert upload(viewer, "po_summary.xlsx").status_code == 403
    assert viewer.get("/api/users").status_code == 403


def test_admin_manages_users(client):
    res = client.post("/api/users", json={"username": "Ravi", "full_name": "Ravi", "password": "ravi-pass-1"})
    assert res.status_code == 200
    assert "password_hash" not in res.json()
    ravi_id = res.json()["id"]

    client.patch(f"/api/users/{ravi_id}", json={"is_active": False})
    res = client.post("/api/auth/login", data={"username": "ravi", "password": "ravi-pass-1"})
    assert res.status_code == 401  # deactivated users can't log in

    me = client.get("/api/auth/me").json()
    assert client.patch(f"/api/users/{me['id']}", json={"is_active": False}).status_code == 400


# ---------- monthly uploads ----------

def make_workbook(sheet_name, changes=None):
    """A copy of the May sample with the sheet renamed and some cells changed, as .xlsx bytes."""
    import io
    import openpyxl

    wb = openpyxl.load_workbook(DATA / "po_summary.xlsx")
    ws = wb.active
    ws.title = sheet_name
    for cell, value in (changes or {}).items():
        ws[cell] = value
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def upload_bytes(client, name, content, preview=False):
    url = "/api/upload/preview" if preview else "/api/upload"
    return client.post(url, files={"file": (name, content)})


def months(client):
    return {p["label"]: p["rows"] for p in client.get("/api/periods").json() if p["type"] == "orders"}


def test_preview_saves_nothing(client):
    res = upload_bytes(client, "june.xlsx", make_workbook("JUNE - 2026"), preview=True)
    assert res.status_code == 200
    sheet = res.json()["sheets"][0]
    assert sheet["period_label"] == "June 2026" and sheet["existing_rows"] == 0
    assert client.get("/api/orders").json() == []


def test_next_month_adds_and_carried_over_rows_are_not_double_counted(client):
    upload(client, "po_summary.xlsx")  # May
    # June's sheet repeats May's lines, and invoice 29 (row 4) has now been paid.
    june = make_workbook("JUNE - 2026", {"AA4": "YES"})

    preview = upload_bytes(client, "june.xlsx", june, preview=True).json()["sheets"][0]
    assert preview["carried_over"] == [{"from": "May 2026", "rows": 12}]

    upload_bytes(client, "june.xlsx", june)
    # 12 lines match by invoice or PO + description and move to June. The 3 lines with no PO and no
    # invoice can't be matched, so they stay in May as well.
    assert months(client) == {"June 2026": 15, "May 2026": 3}

    kpis = client.get("/api/dashboard").json()["kpis"]
    assert kpis["invoiced_total"] == 196756.46  # not doubled
    assert kpis["received_total"] == 107365.56 + 5192  # June's newer "paid" status wins


def test_reuploading_an_older_month_does_not_overwrite_newer_data(client):
    upload(client, "po_summary.xlsx")
    upload_bytes(client, "june.xlsx", make_workbook("JUNE - 2026", {"AA4": "YES"}))
    res = upload(client, "po_summary.xlsx")  # May again, with the old "unpaid" status
    assert res.json()["sheets"][0]["skipped_newer"] == [{"in": "June 2026", "rows": 12}]
    assert months(client) == {"June 2026": 15, "May 2026": 3}
    assert client.get("/api/dashboard").json()["kpis"]["received_total"] == 107365.56 + 5192


def test_month_guessed_from_dates_when_sheet_name_has_none(client):
    sheet = upload_bytes(client, "x.xlsx", make_workbook("Sheet1"), preview=True).json()["sheets"][0]
    assert sheet["period"] == "2026-05"
    assert "using May 2026" in sheet["warnings"][0]


def test_missing_column_is_a_warning(client):
    sheet = upload_bytes(client, "x.xlsx", make_workbook("JUNE - 2026", {"Y1": "SOMETHING ELSE"}), preview=True).json()["sheets"][0]
    assert "Column(s) not found, left blank: GRN" in sheet["warnings"]


def test_two_tabs_for_the_same_month_is_an_error(client):
    import io
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(make_workbook("JUNE - 2026")))
    wb.copy_worksheet(wb.active).title = "June 2026 (2)"
    out = io.BytesIO()
    wb.save(out)
    res = upload_bytes(client, "x.xlsx", out.getvalue(), preview=True).json()
    assert res["can_import"] is False
    assert upload_bytes(client, "x.xlsx", out.getvalue()).status_code == 400


# ---------- viewing and deleting uploaded data ----------

def kpis(client):
    return client.get("/api/dashboard").json()["kpis"]


def test_uploaded_file_can_be_viewed_and_downloaded(client):
    upload_id = upload(client, "po_summary.xlsx").json()["upload_id"]
    sheet = client.get(f"/api/uploads/{upload_id}/view").json()["sheets"][0]
    assert sheet["name"] == "MAY - 2026" and sheet["period_label"] == "May 2026"
    assert sheet["headers"][:2] == ["SR.NO.", "CUSTOMER NAME"]
    assert sheet["rows"][0]["cells"][1] == "BFL"

    res = client.get(f"/api/uploads/{upload_id}/file")
    assert res.content == (DATA / "po_summary.xlsx").read_bytes()


def test_deleting_a_month_brings_back_the_older_copies(client):
    upload(client, "po_summary.xlsx")
    upload_bytes(client, "june.xlsx", make_workbook("JUNE - 2026", {"AA4": "YES"}))

    preview = client.delete("/api/periods/orders/2026-06?dry_run=true").json()["deleted"][0]
    assert preview["rows"] == 15 and preview["restored"] == [{"label": "May 2026", "rows": 12}]
    assert months(client) == {"June 2026": 15, "May 2026": 3}  # dry run changed nothing

    client.delete("/api/periods/orders/2026-06")
    assert months(client) == {"May 2026": 15}
    assert kpis(client)["received_total"] == 107365.56  # back to May's status


def test_deleting_an_upload_removes_its_data_and_file(client):
    upload(client, "po_summary.xlsx")
    june_id = upload_bytes(client, "june.xlsx", make_workbook("JUNE - 2026")).json()["upload_id"]
    assert client.get(f"/api/uploads/{june_id}/file").status_code == 200

    res = client.delete(f"/api/uploads/{june_id}").json()
    assert res["deleted"][0]["label"] == "June 2026" and res["file_deleted"]
    assert months(client) == {"May 2026": 15}
    assert client.get(f"/api/uploads/{june_id}/file").status_code == 404
    assert [u["filename"] for u in client.get("/api/uploads").json()] == ["po_summary.xlsx"]


def test_too_big_file_is_refused(client):
    big = make_workbook("JUNE - 2026") + b"x" * (4 * 1024 * 1024)
    assert upload_bytes(client, "big.xlsx", big, preview=True).status_code == 413


def test_older_month_uploaded_after_newer_stays_hidden_until_newer_is_deleted(client):
    upload_bytes(client, "june.xlsx", make_workbook("JUNE - 2026", {"AA4": "YES"}))
    upload(client, "po_summary.xlsx")  # May arrives later; June already has 12 of its orders
    assert months(client) == {"June 2026": 15, "May 2026": 3}
    client.delete("/api/periods/orders/2026-06")
    assert months(client) == {"May 2026": 15}
    assert kpis(client)["invoiced_total"] == 196756.46


def test_viewer_cannot_delete(anon):
    viewer = login(anon, "viewer", "viewer-pass")
    assert viewer.delete("/api/periods/orders/2026-05").status_code == 403


# ---------- typing in rows, custom columns, export ----------

def test_add_edit_delete_an_order(client):
    res = client.post("/api/orders", json={"customer": "BFL", "description": "Chiller service visit",
                                           "order_date": "2026-06-10", "amount": 10000})
    assert res.status_code == 200, res.text
    order = res.json()
    assert order["cgst"] == 900 and order["total_amount"] == 11800  # 9% + 9% GST, like the sheet
    assert order["period"] == "2026-06" and order["upload_id"] is None

    res = client.patch(f"/api/orders/{order['id']}", json={"invoice_number": "45", "invoice_date": "2026-06-20",
                                                           "payment_received": True})
    assert res.json()["payment_received"] is True
    assert kpis(client)["received_total"] == 11800

    assert client.delete(f"/api/orders/{order['id']}").json()["from_excel"] is False
    assert client.get("/api/orders").json() == []


def test_order_validation(client):
    assert client.post("/api/orders", json={"customer": "BFL"}).status_code == 400  # no description
    assert client.post("/api/orders", json={"customer": "BFL", "description": "x", "amount": -5}).status_code == 400
    res = client.post("/api/orders", json={"customer": "BFL", "description": "x",
                                           "order_date": "2026-06-10", "invoice_date": "2026-06-01"})
    assert "before the order date" in res.json()["detail"]
    assert client.post("/api/orders", json={"customer": "BFL", "description": "x", "nope": 1}).status_code == 400


def test_typed_in_rows_survive_reupload_and_delete_month(client):
    upload(client, "po_summary.xlsx")
    client.post("/api/orders", json={"customer": "KCPTL", "description": "Extra job", "order_date": "2026-05-20"})
    upload(client, "po_summary.xlsx")  # May again
    client.delete("/api/periods/orders/2026-05")
    assert [o["description"] for o in client.get("/api/orders").json()] == ["Extra job"]


def test_add_quotation(client):
    res = client.post("/api/quotations", json={"work_title": "MCD 1 - AC duct work", "total_amount": 50000,
                                               "work_date": "2027-02-01"})
    assert res.status_code == 200 and res.json()["period"] == "2026-27"  # Feb 2027 is in FY 2026-27
    assert client.post("/api/quotations", json={"total_amount": 5}).status_code == 400  # no title


def test_custom_columns(client):
    res = client.post("/api/fields", json={"entity": "orders", "label": "Site Engineer"})
    assert res.json()["key"] == "site_engineer"
    client.post("/api/fields", json={"entity": "orders", "label": "Warranty till", "type": "date"})
    assert client.post("/api/fields", json={"entity": "orders", "label": "site engineer"}).status_code == 400  # duplicate
    assert client.post("/api/fields", json={"entity": "orders", "label": "Customer Name"}).status_code == 400  # built-in

    order = client.post("/api/orders", json={"customer": "BFL", "description": "x",
                                             "extra": {"site_engineer": "Ravi", "warranty_till": "2027-03-31"}}).json()
    assert order["extra"] == {"site_engineer": "Ravi", "warranty_till": "2027-03-31"}
    assert client.patch(f"/api/orders/{order['id']}", json={"extra": {"warranty_till": "soon"}}).status_code == 400

    field_id = res.json()["id"]
    client.patch(f"/api/fields/{field_id}", json={"label": "Engineer"})
    assert client.get("/api/orders").json()[0]["extra"]["engineer"] == "Ravi"  # values follow the rename
    client.delete(f"/api/fields/{field_id}")
    assert client.get("/api/orders").json()[0]["extra"] == {"warranty_till": "2027-03-31"}


def test_custom_column_is_imported_from_excel(client):
    client.post("/api/fields", json={"entity": "orders", "label": "Site Engineer"})
    res = upload_bytes(client, "x.xlsx", make_workbook("JUNE - 2026", {"AB1": "SITE ENGINEER", "AB2": "Ravi", "AC1": "Remarks"}))
    sheet = res.json()["sheets"][0]
    assert any("REMARKS" in w for w in sheet["warnings"])  # a column the app doesn't know is reported
    first = next(o for o in client.get("/api/orders").json() if o["excel_row"] == 2)
    assert first["extra"] == {"site_engineer": "Ravi"}


def test_export_is_a_backup_that_can_be_uploaded_again(anon, client):
    upload(client, "po_summary.xlsx")
    upload_bytes(client, "june.xlsx", make_workbook("JUNE - 2026", {"AA4": "YES"}))
    upload(client, "quotations.xlsx")
    client.post("/api/fields", json={"entity": "orders", "label": "Site Engineer"})
    client.post("/api/orders", json={"customer": "BFL", "description": "Typed in", "order_date": "2026-07-02",
                                     "amount": 1000, "extra": {"site_engineer": "Ravi"}})
    before = kpis(client)

    res = client.get("/api/export?entity=all")
    assert res.headers["content-type"].startswith("application/vnd.openxmlformats")
    import io
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(res.content))
    assert wb.sheetnames == ["MAY - 2026", "JUNE - 2026", "JULY - 2026", "2026-27"]

    # Wipe everything, then restore by uploading the backup.
    for p in client.get("/api/periods").json():
        client.delete(f"/api/periods/{p['type']}/{p['period']}")
    for o in client.get("/api/orders").json():
        client.delete(f"/api/orders/{o['id']}")
    assert kpis(client)["orders"] == 0
    restored = upload_bytes(client, "backup.xlsx", res.content)
    assert restored.status_code == 200, restored.text
    after = kpis(client)
    assert {k: after[k] for k in ("orders", "invoiced_total", "received_total", "open_quotes_value")} == \
           {k: before[k] for k in ("orders", "invoiced_total", "received_total", "open_quotes_value")}
    typed = next(o for o in client.get("/api/orders").json() if o["description"] == "Typed in")
    assert typed["extra"] == {"site_engineer": "Ravi"}
