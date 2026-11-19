"""Firms: the businesses the client runs. Orders, quotations and uploads each belong to one firm,
and every list, upload, delete and export works on one firm at a time. The dashboard shows one
firm or all of them together.

A firm with data can't be deleted, only archived: archiving hides it from the menus, the upload
window and the dashboard, and keeps every row so it can be restored.
"""
import re
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import case
from sqlmodel import Session, func, select, update

from .models import Firm, Order, Quotation, Upload

# Created the first time the app runs, so there's always a firm to upload into. Renamable.
DEFAULT_FIRMS = ["Siddhivinayak Enterprises", "Second firm"]

GSTIN = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")  # 2 state digits + PAN + entity + Z + check
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE = re.compile(r"^[0-9+\-() ]{7,20}$")
DETAILS = ("name", "gstin", "contact_person", "phone", "email", "address", "notes")


def all_firms(session: Session) -> list[Firm]:
    """Every firm, archived ones included, in menu order. Creates the defaults on an empty database."""
    firms = list(session.exec(select(Firm).order_by(Firm.position, Firm.id)).all())
    if not firms:
        firms = [Firm(name=name, position=i) for i, name in enumerate(DEFAULT_FIRMS)]
        session.add_all(firms)
        session.commit()
        for firm in firms:
            session.refresh(firm)
    return firms


def active_firms(session: Session) -> list[Firm]:
    return [f for f in all_firms(session) if f.archived_at is None]


def get_firm(session: Session, firm_id: int | None, active: bool = False) -> Firm:
    """The firm with this id. active=True refuses archived firms (for adding data to them)."""
    all_firms(session)  # makes sure the default firms exist (fresh database)
    firm = session.get(Firm, firm_id) if firm_id is not None else None
    if firm is None:
        raise HTTPException(400, "Choose which firm this is for")
    if active and firm.archived_at is not None:
        raise HTTPException(400, f"{firm.name} is archived. Restore it on the Firms page to add data to it.")
    return firm


def file_unassigned_rows(session: Session):
    """Data from before there were firms belongs to the first firm."""
    first = all_firms(session)[0]
    for table in (Order, Quotation, Upload):
        session.execute(update(table).where(table.firm_id.is_(None)).values(firm_id=first.id))
    session.commit()


# ---------- adding and editing ----------

def clean_details(session: Session, body: dict, firm: Firm | None) -> dict:
    """Check the form values. Empty = not filled in. Returns only the fields that were sent."""
    values = {}
    for key in DETAILS:
        if key in body:
            text = (body[key] or "").strip()
            values[key] = text or None
    if "gstin" in values and values["gstin"]:
        values["gstin"] = values["gstin"].upper().replace(" ", "")
        if not GSTIN.match(values["gstin"]):
            raise HTTPException(400, "GSTIN should be 15 characters, like 27ABCDE1234F1Z5")
    if values.get("email") and not EMAIL.match(values["email"]):
        raise HTTPException(400, "That email address doesn't look right")
    if values.get("phone") and not PHONE.match(values["phone"]):
        raise HTTPException(400, "Phone number: 7 to 20 digits (spaces, +, - and brackets are fine)")

    name = values["name"] if "name" in values else (firm.name if firm else None)
    if not name or len(name) > 60:
        raise HTTPException(400, "Firm name must be 1 to 60 characters")
    same_name = session.exec(select(Firm).where(func.lower(Firm.name) == name.lower())).first()
    if same_name and (firm is None or same_name.id != firm.id):
        raise HTTPException(400, f"There is already a firm called {same_name.name}")
    return values


def create_firm(session: Session, body: dict) -> Firm:
    values = clean_details(session, body, None)
    position = max((f.position for f in all_firms(session)), default=-1) + 1
    firm = Firm(**values, position=position)
    session.add(firm)
    return firm


def update_firm(session: Session, firm: Firm, body: dict) -> Firm:
    for key, value in clean_details(session, body, firm).items():
        setattr(firm, key, value)
    if "archived" in body:
        if body["archived"] and firm.archived_at is None:
            if len(active_firms(session)) <= 1:
                raise HTTPException(400, "This is the only active firm. Add another one before archiving it.")
            firm.archived_at = datetime.now(timezone.utc)
        elif not body["archived"]:
            firm.archived_at = None
    session.add(firm)
    return firm


def move_firm(session: Session, firm: Firm, direction: int):
    """Swap with the neighbour above (-1) or below (+1) in the menu."""
    firms = all_firms(session)
    i = next(i for i, f in enumerate(firms) if f.id == firm.id)
    j = i + direction
    if 0 <= j < len(firms):
        firms[i], firms[j] = firms[j], firms[i]
    for position, f in enumerate(firms):  # renumber 0, 1, 2... so positions never clash
        f.position = position
        session.add(f)


def delete_firm(session: Session, firm: Firm):
    counts = firm_counts(session).get(firm.id, {})
    rows = counts.get("orders", 0) + counts.get("quotations", 0) + counts.get("uploads", 0)
    if rows:
        raise HTTPException(400, f"{firm.name} still has data ({counts.get('orders', 0)} orders, "
                                 f"{counts.get('quotations', 0)} quotations, {counts.get('uploads', 0)} uploads). "
                                 "Archive it instead, or delete its data on the Data files page first.")
    if firm.archived_at is None and len(active_firms(session)) <= 1:
        raise HTTPException(400, "This is the only active firm. Add another one before deleting it.")
    session.delete(firm)


# ---------- numbers for the Firms page ----------

def firm_counts(session: Session) -> dict[int, dict]:
    """Per firm: rows of each kind, money invoiced/received, and when data was last uploaded."""
    from .importer import VISIBLE  # importer imports this module, so import here to avoid a loop

    result: dict[int, dict] = {}

    def row(firm_id):
        return result.setdefault(firm_id, {"orders": 0, "quotations": 0, "uploads": 0, "invoiced": 0.0,
                                           "received": 0.0, "last_upload": None})

    paid = case((Order.payment_received.is_(True), Order.total_amount), else_=0)
    invoiced = case((Order.invoice_number.is_not(None), Order.total_amount), else_=0)
    for firm_id, count, inv, rec in session.exec(
        select(Order.firm_id, func.count(), func.coalesce(func.sum(invoiced), 0), func.coalesce(func.sum(paid), 0))
        .where(VISIBLE).group_by(Order.firm_id)
    ):
        r = row(firm_id)
        r["orders"], r["invoiced"], r["received"] = count, round(inv, 2), round(rec, 2)
    for firm_id, count in session.exec(select(Quotation.firm_id, func.count()).group_by(Quotation.firm_id)):
        row(firm_id)["quotations"] = count
    for firm_id, count, last in session.exec(
        select(Upload.firm_id, func.count(), func.max(Upload.uploaded_at)).group_by(Upload.firm_id)
    ):
        r = row(firm_id)
        r["uploads"] = count
        r["last_upload"] = last.replace(tzinfo=last.tzinfo or timezone.utc).isoformat() if last else None
    for r in result.values():
        r["outstanding"] = round(r["invoiced"] - r["received"], 2)
    return result
