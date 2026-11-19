"""Decide what an upload will do, do it, and undo it (delete a month or a whole uploaded file).

plan_import() works out what happens to each sheet without changing anything. The preview
endpoint shows that plan to the user, and the import endpoint runs the same plan with commit_import().

Every upload is for one firm, and everything below happens inside that firm: firm A's May is never
replaced or hidden by firm B's May.

Rules for monthly PO sheets:
  * A sheet belongs to a month ("JUNE - 2026" -> 2026-06).
  * Uploading a month that's already loaded replaces that month.
  * The same order often appears again in the next month's sheet (e.g. invoiced in May, paid in
    June). The copy from the LATER month is shown. The older copy is hidden (replaced_by_period),
    not deleted, so deleting the later month brings it back.
"""
import re
from collections import Counter
from dataclasses import dataclass, field

from sqlmodel import Session, delete, func, or_, select, update

from .excel_import import SheetResult, period_label
from .models import Order, Quotation, StoredFile, Upload

TABLES = {"orders": Order, "quotations": Quotation}

# Orders that count: not hidden behind a newer month's copy. Every report must filter on this.
VISIBLE = Order.replaced_by_period.is_(None)


def from_excel(table):
    """Rows that came from an uploaded file. Rows typed into the app (upload_id NULL) are never
    replaced or deleted by uploads or by "Delete month"."""
    return table.upload_id.is_not(None)


@dataclass
class SheetPlan:
    sheet: SheetResult
    existing_rows: int = 0  # rows already stored for this month, which this upload replaces
    rows: list[dict] = field(default_factory=list)  # what will be inserted
    replaces_ids: list[int] = field(default_factory=list)  # stored older copies to hide
    carried_over: Counter = field(default_factory=Counter)  # month label -> rows updated from it
    skipped_newer: Counter = field(default_factory=Counter)  # month label -> rows a newer month already has

    def summary(self) -> dict:
        s = self.sheet
        return {
            "sheet": s.sheet_name,
            "type": s.kind,
            "period": s.period,
            "period_label": period_label(s.period) if s.kind else None,
            "rows": len(self.rows),
            "existing_rows": self.existing_rows,
            "carried_over": [{"from": label, "rows": n} for label, n in self.carried_over.items()],
            "skipped_newer": [{"in": label, "rows": n} for label, n in self.skipped_newer.items()],
            "warnings": s.warnings,
            "errors": s.errors,
        }


def _norm(text) -> str:
    return re.sub(r"\W+", " ", (text or "").upper()).strip()


def same_order(a: dict, b: dict) -> bool:
    """Is b the same PO line as a, just copied into another month's sheet?"""
    if not a["customer"] or a["customer"] != b["customer"]:
        return False
    if a["invoice_number"] and b["invoice_number"]:
        # Invoice numbers restart every financial year, so also check the PO when both have one.
        same_po = not (a["po_number"] and b["po_number"]) or a["po_number"] == b["po_number"]
        return a["invoice_number"] == b["invoice_number"] and same_po
    return bool(a["po_number"]) and a["po_number"] == b["po_number"] and _norm(a["description"]) == _norm(b["description"])


# ---------- import ----------

def plan_import(session: Session, sheets: list[SheetResult], firm_id: int) -> list[SheetPlan]:
    plans = [SheetPlan(sheet=s) for s in sheets]
    seen = {}
    for s in sheets:
        if s.kind and s.period and not s.errors:
            first = seen.setdefault((s.kind, s.period), s.sheet_name)
            if first != s.sheet_name:
                s.errors.append(f"Same {period_label(s.period)} data as sheet '{first}'. Keep only one of them.")
    ready = [p for p in plans if p.sheet.kind and not p.sheet.errors]

    for plan in ready:
        table = TABLES[plan.sheet.kind]
        plan.existing_rows = session.exec(
            select(func.count()).select_from(table)
            .where(table.firm_id == firm_id, table.period == plan.sheet.period, from_excel(table))
        ).one()
        plan.rows = [dict(row) for row in plan.sheet.rows]
        if plan.sheet.kind == "orders":
            for row in plan.rows:
                row["replaced_by_period"] = None

    # Carried-over orders. Go through the months oldest first, comparing each row with visible rows
    # from other months: stored ones and earlier sheets in this same file. (Rows hidden behind a month
    # this upload replaces count as visible: the replace un-hides them first.)
    order_plans = sorted((p for p in ready if p.sheet.kind == "orders"), key=lambda p: p.sheet.period)
    months = {p.sheet.period for p in order_plans}
    stored = session.exec(
        select(Order).where(Order.firm_id == firm_id, Order.period.not_in(months),
                            or_(VISIBLE, Order.replaced_by_period.in_(months)))
    ).all()
    candidates = [{**o.model_dump(), "_row": None} for o in stored]

    for plan in order_plans:
        month = plan.sheet.period
        for row in plan.rows:
            matches = [c for c in candidates if same_order(c, row)]
            newer = [c for c in matches if c["period"] > month]
            if newer:
                # A later month already has this order, so its version stays on show. Store this one hidden.
                row["replaced_by_period"] = min(c["period"] for c in newer)
                plan.skipped_newer[period_label(row["replaced_by_period"])] += 1
                continue
            for match in matches:  # older copies: hide them behind this month
                plan.carried_over[period_label(match["period"])] += 1
                if match["_row"] is None:
                    plan.replaces_ids.append(match["id"])
                else:
                    match["_row"]["replaced_by_period"] = month  # an earlier sheet in this same file
                candidates.remove(match)
        candidates += [{**row, "period": month, "_row": row} for row in plan.rows if row["replaced_by_period"] is None]
    return plans


def commit_import(session: Session, plans: list[SheetPlan], filename: str, firm_id: int) -> Upload:
    upload = Upload(filename=filename, firm_id=firm_id)
    session.add(upload)
    session.flush()  # sends the INSERT so upload.id is filled in

    for plan in plans:
        s = plan.sheet
        if not s.kind or s.errors:
            continue
        table = TABLES[s.kind]
        unhidden = []
        if s.kind == "orders":
            # Rows hidden behind the month we're replacing become visible again...
            unhidden = session.exec(
                select(Order).where(Order.firm_id == firm_id, Order.replaced_by_period == s.period)
            ).all()
            for o in unhidden:
                o.replaced_by_period = None
        session.execute(delete(table).where(table.firm_id == firm_id, table.period == s.period, from_excel(table)))
        if plan.replaces_ids:
            # ...unless the new sheet has them again, in which case they're hidden again here.
            session.execute(update(Order).where(Order.id.in_(plan.replaces_ids)).values(replaced_by_period=s.period))
        session.add_all(
            table(**row, upload_id=upload.id, firm_id=firm_id, sheet_name=s.sheet_name, period=s.period)
            for row in plan.rows
        )
        session.flush()
        _rehome(session, [o for o in unhidden if o.id not in plan.replaces_ids])
        if s.kind == "orders":
            upload.orders_imported += len(plan.rows)
        else:
            upload.quotations_imported += len(plan.rows)

    session.commit()  # all-or-nothing: if anything above failed, nothing is saved
    return upload


# ---------- delete ----------

def _rehome(session: Session, orders: list[Order]) -> Counter:
    """Orders whose hiding month went away: hide them behind the next later month that has the
    same order, or show them again. Returns how many became visible, per month label."""
    shown = Counter()
    for o in orders:
        later = session.exec(
            select(Order).where(VISIBLE, Order.firm_id == o.firm_id, Order.customer == o.customer,
                                Order.period > o.period, Order.id != o.id)
            .order_by(Order.period)
        ).all()
        match = next((x for x in later if same_order(x.model_dump(), o.model_dump())), None)
        o.replaced_by_period = match.period if match else None
        if not match:
            shown[period_label(o.period)] += 1
    return shown


def delete_period(session: Session, kind: str, period: str, firm_id: int) -> dict:
    """Remove one firm's month (orders) or financial year (quotations) that came from Excel. Rows typed
    into the app are kept. Doesn't commit."""
    table = TABLES[kind]
    in_period = (table.firm_id == firm_id, table.period == period, from_excel(table))
    rows = session.exec(select(func.count()).select_from(table).where(*in_period)).one()
    orphans = session.exec(
        select(Order).where(Order.firm_id == firm_id, Order.replaced_by_period == period)
    ).all() if kind == "orders" else []
    session.execute(delete(table).where(*in_period))
    session.flush()
    shown = _rehome(session, orphans)
    return {
        "type": kind,
        "firm_id": firm_id,
        "period": period,
        "label": period_label(period),
        "rows": rows,
        "restored": [{"label": label, "rows": n} for label, n in shown.items()],
    }


def delete_upload(session: Session, upload: Upload) -> list[dict]:
    """Remove every month/year whose data came from this upload, then the upload itself. Doesn't commit."""
    results = []
    for kind, table in TABLES.items():
        periods = session.exec(select(table.firm_id, table.period).where(table.upload_id == upload.id).distinct()).all()
        results += [delete_period(session, kind, period, firm_id) for firm_id, period in sorted(periods)]
    session.execute(delete(StoredFile).where(StoredFile.upload_id == upload.id))
    session.delete(upload)
    return results
