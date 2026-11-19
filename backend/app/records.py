"""Adding and editing single orders/quotations in the app, and the admin's custom columns.

Values arrive as JSON from the forms. They are checked and converted here with the same rules the
Excel importer uses, so a row typed in the app looks exactly like one that came from Excel.
"""
from datetime import date

from fastapi import HTTPException
from sqlmodel import Session, func, select

from .excel_import import (
    BOOL_FIELDS, CODE_FIELDS, DATE_FIELDS, NUMBER_FIELDS, ORDER_COLUMNS, QUOTATION_COLUMNS, TEXT_FIELDS,
    snake, to_code, to_text,
)
from .firms import get_firm
from .models import ColumnLayout, CustomField, Order, Quotation, WorkLocation

TABLES = {"orders": Order, "quotations": Quotation}
# An order's total is always amount + CGST + SGST, so it isn't typed in.
EDITABLE = {"orders": set(ORDER_COLUMNS.values()) - {"total_amount"}, "quotations": set(QUOTATION_COLUMNS.values())}
REQUIRED = {"orders": ("customer", "description"), "quotations": ("work_title",)}
FIELD_TYPES = ("text", "number", "date", "yesno")
MANUAL_SHEET = "Entered in app"


def bad(message: str):
    raise HTTPException(400, message)


def label(field: str) -> str:
    return field.replace("_", " ").capitalize()


# ---------- converting form values ----------

def convert(field: str, value):
    """One built-in field's value from a form -> the type stored in the database."""
    if value is None or value == "":
        return None
    if field in BOOL_FIELDS:
        if not isinstance(value, bool):
            bad(f"{label(field)} must be yes or no")
        return value
    if field in DATE_FIELDS:
        try:
            return date.fromisoformat(str(value))
        except ValueError:
            bad(f"{label(field)} must be a date like 2026-06-30")
    if field in NUMBER_FIELDS:
        try:
            number = float(value)
        except (TypeError, ValueError):
            bad(f"{label(field)} must be a number")
        if number < 0:
            bad(f"{label(field)} can't be negative")
        return round(number, 2)
    if field in CODE_FIELDS:
        return to_code(value)
    return to_text(value) if field in TEXT_FIELDS else str(value).strip() or None


def convert_extra(session: Session, entity: str, values: dict) -> dict:
    """Values for custom columns. Unknown columns are refused; types are checked."""
    fields = {f.key: f for f in custom_fields(session, entity)}
    result = {}
    for key, value in values.items():
        field = fields.get(key)
        if field is None:
            bad(f"There is no custom column '{key}'")
        if value is None or value == "":
            result[key] = None
        elif field.type == "number":
            try:
                result[key] = float(value)
            except (TypeError, ValueError):
                bad(f"{field.label} must be a number")
        elif field.type == "date":
            try:
                result[key] = date.fromisoformat(str(value)).isoformat()
            except ValueError:
                bad(f"{field.label} must be a date")
        elif field.type == "yesno":
            if not isinstance(value, bool):
                bad(f"{field.label} must be yes or no")
            result[key] = value
        else:
            result[key] = str(value).strip() or None
    return result


def financial_year_of(d: date) -> str:
    """Indian financial year, April to March: 2026-06-15 -> '2026-27'."""
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start}-{(start + 1) % 100:02d}"


# ---------- saving ----------

def save(session: Session, entity: str, body: dict, row=None):
    """Create (row=None) or update a row from form data. Doesn't commit.
    A new row needs `firm_id`; a saved row stays in its firm."""
    allowed = EDITABLE[entity] | {"extra"} | ({"firm_id"} if row is None else set())
    unknown = set(body) - allowed
    if unknown:
        bad(f"Unknown field(s): {', '.join(sorted(unknown))}")
    values = {k: convert(k, v) for k, v in body.items() if k not in ("extra", "firm_id")}

    if row is None:
        firm = get_firm(session, body.get("firm_id"), active=True)
        row = TABLES[entity](sheet_name=MANUAL_SHEET, excel_row=0, firm_id=firm.id)
    for field in REQUIRED[entity]:
        if (values[field] if field in values else getattr(row, field)) is None:
            bad(f"{label(field)} is required")

    if entity == "orders":
        if "order_date" in values or "invoice_date" in values:
            ordered = values.get("order_date", row.order_date)
            invoiced = values.get("invoice_date", row.invoice_date)
            if ordered and invoiced and invoiced < ordered:
                bad("Invoice date can't be before the order date")
        # GST like the client's sheet: CGST and SGST are 9% each unless typed in. Total is worked out.
        if "amount" in values:
            amount = values["amount"]
            for tax in ("cgst", "sgst"):
                if tax not in values:
                    values[tax] = round(amount * 0.09, 2) if amount is not None else None
        for key, value in values.items():
            setattr(row, key, value)
        row.total_amount = round(row.amount + (row.cgst or 0) + (row.sgst or 0), 2) if row.amount is not None else None
    else:
        for key, value in values.items():
            setattr(row, key, value)
        add_locations(session, [row.work_location])  # a newly typed location joins the list

    if "extra" in body:
        if not isinstance(body["extra"], dict):
            bad("extra must be an object")
        merged = {**(row.extra or {}), **convert_extra(session, entity, body["extra"])}
        # Assign a new dict: changes made inside the old one wouldn't be noticed and saved.
        row.extra = {k: v for k, v in merged.items() if v is not None} or None

    if row.upload_id is None:
        # Typed-in rows are filed under the month (orders) or financial year (quotations) of their dates.
        if entity == "orders":
            day = row.invoice_date or row.order_date or date.today()
            row.period = day.strftime("%Y-%m")
        else:
            row.period = financial_year_of(row.work_date or date.today())
    session.add(row)
    return row


# ---------- custom columns ----------

def custom_fields(session: Session, entity: str | None = None) -> list[CustomField]:
    query = select(CustomField).order_by(CustomField.entity, CustomField.position, CustomField.id)
    if entity:
        query = query.where(CustomField.entity == entity)
    return list(session.exec(query).all())


def custom_fields_for_import(session: Session) -> dict:
    return {e: [{"key": f.key, "type": f.type} for f in custom_fields(session, e)] for e in TABLES}


def check_label(session: Session, entity: str, text: str, ignore_id: int | None = None) -> tuple[str, str]:
    text = (text or "").strip()
    key = snake(text)
    if not key or len(text) > 40:
        bad("Column name must be 1 to 40 characters, with at least one letter or number")
    # The key is how an Excel header is matched, so it can't collide with a built-in column.
    builtin = set(ORDER_COLUMNS) | set(ORDER_COLUMNS.values()) | set(QUOTATION_COLUMNS) | set(QUOTATION_COLUMNS.values())
    if key in builtin | {"sr_no", "excel_row", "id", "period", "extra"}:
        bad(f"'{text}' is already a standard column")
    clash = session.exec(select(CustomField).where(CustomField.entity == entity, CustomField.key == key)).first()
    if clash and clash.id != ignore_id:
        bad(f"There is already a column called '{clash.label}'")
    return text, key


def rows_with(session: Session, field: CustomField):
    table = TABLES[field.entity]
    return [r for r in session.exec(select(table).where(table.extra.is_not(None))).all() if field.key in (r.extra or {})]


def rename_field(session: Session, field: CustomField, new_label: str):
    new_label, new_key = check_label(session, field.entity, new_label, ignore_id=field.id)
    if new_key != field.key:
        for row in rows_with(session, field):
            values = dict(row.extra)
            values[new_key] = values.pop(field.key)
            row.extra = values
            session.add(row)
    field.label, field.key = new_label, new_key
    session.add(field)


def delete_field(session: Session, field: CustomField) -> int:
    rows = rows_with(session, field)
    for row in rows:
        row.extra = {k: v for k, v in row.extra.items() if k != field.key} or None
        session.add(row)
    layout = session.get(ColumnLayout, field.entity)
    if layout and custom_key(field) in layout.columns:
        layout.columns = [c for c in layout.columns if c != custom_key(field)]
        session.add(layout)
    session.delete(field)
    return len(rows)


# ---------- column order ----------

# The columns of the Orders / Quotations tables in the app, by default in this order. Must match
# BUILT_IN_COLUMNS in frontend/src/app/core/columns.ts.
BUILT_IN_COLUMNS = {
    "orders": ["order_date", "customer", "vendor_code", "po_number", "description", "invoice", "total_amount", "status"],
    "quotations": ["quote_number", "work_title", "work_location", "total_amount", "po_number", "status"],
}


def custom_key(field: CustomField) -> str:
    """How a custom column is named in the layout. By id, so renaming it doesn't lose its place."""
    return f"custom:{field.id}"


def column_order(session: Session, entity: str) -> list[str]:
    """The saved order, minus columns that no longer exist. Columns missing from it (a new built-in
    column, or a custom one added before layouts existed) go just before Status, at the end."""
    valid = BUILT_IN_COLUMNS[entity] + [custom_key(f) for f in custom_fields(session, entity)]
    layout = session.get(ColumnLayout, entity)
    saved = [c for c in (layout.columns if layout else []) if c in valid]
    missing = [c for c in valid if c not in saved and c != "status"]
    if "status" not in saved:
        missing.append("status")
    if "status" in saved:
        at = saved.index("status")
        return saved[:at] + missing + saved[at:]
    return saved + missing


def save_column_order(session: Session, entity: str, columns: list[str]) -> list[str]:
    valid = set(BUILT_IN_COLUMNS[entity]) | {custom_key(f) for f in custom_fields(session, entity)}
    if len(set(columns)) != len(columns) or not set(columns) <= valid:
        bad("Unknown or repeated column in the new order")
    layout = session.get(ColumnLayout, entity) or ColumnLayout(entity=entity)
    layout.columns = list(columns)
    session.add(layout)
    return column_order(session, entity)


def place_column(session: Session, field: CustomField, after: str | None):
    """Put a new custom column right after `after` (a column key), or first when after is ""."""
    if after is None:  # not given: it goes just before Status, like before
        return
    order = [c for c in column_order(session, field.entity) if c != custom_key(field)]
    if after and after not in order:
        bad("The column to insert after doesn't exist")
    order.insert(order.index(after) + 1 if after else 0, custom_key(field))
    save_column_order(session, field.entity, order)


# ---------- work locations ----------

def add_locations(session: Session, names) -> int:
    """Add names to the location list if they aren't in it yet (ignoring case). Doesn't commit."""
    known = {n.upper() for n in session.exec(select(WorkLocation.name)).all()}
    added = 0
    for name in names:
        name = to_text(name)
        if name and name.upper() not in known:
            session.add(WorkLocation(name=name))
            known.add(name.upper())
            added += 1
    return added


def list_locations(session: Session) -> list[dict]:
    """The location list, with how many quotations use each one."""
    used = dict(session.exec(
        select(Quotation.work_location, func.count()).where(Quotation.work_location.is_not(None))
        .group_by(Quotation.work_location)
    ).all())
    result = [{"id": loc.id, "name": loc.name, "quotations": used.pop(loc.name, 0)}
              for loc in session.exec(select(WorkLocation)).all()]
    # Used by a quotation but not in the list (e.g. data from before the list existed).
    result += [{"id": None, "name": name, "quotations": n} for name, n in used.items()]
    return sorted(result, key=lambda r: r["name"].upper())
