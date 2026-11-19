"""Numbers for the dashboard. Each query is one SQL SELECT with SUM/COUNT/GROUP BY."""
from collections import defaultdict
from datetime import date

from sqlalchemy import and_, case
from sqlmodel import Session, func, select

from .firms import active_firms, all_firms
from .importer import VISIBLE
from .models import Order, Quotation

INVOICED = Order.invoice_number.is_not(None)  # used together with VISIBLE (hidden older copies don't count)
PAID = Order.payment_received.is_(True)


def total(column):
    """SUM() returns NULL when there are no rows, so fall back to 0."""
    return func.coalesce(func.sum(column), 0)


def build_dashboard(session: Session, firm_id: int | None = None) -> dict:
    """firm_id=None: every active firm added together. Otherwise just that firm.
    (Archived firms keep their data, but it's left out of the combined numbers.)"""
    firms = [f for f in all_firms(session) if f.id == firm_id] if firm_id else active_firms(session)
    ids = [f.id for f in firms]
    # Every order query below uses `visible`: not hidden behind a newer month, and in the chosen firm(s).
    visible = and_(VISIBLE, Order.firm_id.in_(ids))
    quotes = Quotation.firm_id.in_(ids)

    # ----- headline KPIs -----
    invoiced_count, invoiced_total, received_total = session.exec(
        select(func.count(), total(Order.total_amount), total(case((PAID, Order.total_amount), else_=0)))
        .where(visible, INVOICED)
    ).one()
    order_count = session.exec(select(func.count()).select_from(Order).where(visible)).one()

    # ----- outstanding money per customer -----
    by_customer = [
        {"customer": customer or "(blank)", "invoiced": round(inv, 2), "received": round(rec, 2),
         "outstanding": round(inv - rec, 2)}
        for customer, inv, rec in session.exec(
            select(Order.customer, total(Order.total_amount), total(case((PAID, Order.total_amount), else_=0)))
            .where(visible, INVOICED)
            .group_by(Order.customer)
        )
    ]

    by_category = [
        {"category": category or "(blank)", "orders": count, "invoiced": round(amount, 2)}
        for category, count, amount in session.exec(
            select(Order.category, func.count(), total(case((INVOICED, Order.total_amount), else_=0)))
            .where(visible)
            .group_by(Order.category)
            .order_by(func.count().desc())
        )
    ]

    # Monthly totals are grouped in Python: SQLite and PostgreSQL format dates differently in SQL.
    months = defaultdict(float)
    for invoice_date, amount in session.exec(select(Order.invoice_date, Order.total_amount).where(visible, INVOICED)):
        if invoice_date and amount:
            months[invoice_date.strftime("%Y-%m")] += amount
    by_month = [{"month": m, "invoiced": round(v, 2)} for m, v in sorted(months.items())]

    # ----- payments per firm, and per vendor code inside each firm -----
    vendors = defaultdict(list)
    for firm_id, vendor_code, invoices, inv, rec in session.exec(
        select(Order.firm_id, Order.vendor_code, func.count(), total(Order.total_amount),
               total(case((PAID, Order.total_amount), else_=0)))
        .where(visible, INVOICED)
        .group_by(Order.firm_id, Order.vendor_code)
    ):
        vendors[firm_id].append({"vendor_code": vendor_code, "invoices": invoices, "invoiced": round(inv, 2),
                                 "received": round(rec, 2), "outstanding": round(inv - rec, 2)})
    # Which customers each vendor code is used with (the code is the number a customer gave the firm).
    customers = defaultdict(set)
    for firm_id, vendor_code, customer in session.exec(
        select(Order.firm_id, Order.vendor_code, Order.customer).where(visible, INVOICED).distinct()
    ):
        if customer:
            customers[(firm_id, vendor_code)].add(customer)
    by_firm = []
    for firm in firms:
        rows = sorted(vendors.get(firm.id, []), key=lambda v: (v["vendor_code"] is None, -v["invoiced"]))
        for v in rows:
            v["customers"] = sorted(customers[(firm.id, v["vendor_code"])])
        invoiced = round(sum(v["invoiced"] for v in rows), 2)
        received = round(sum(v["received"] for v in rows), 2)
        by_firm.append({"firm_id": firm.id, "name": firm.name, "invoiced": invoiced, "received": received,
                        "outstanding": round(invoiced - received, 2), "vendors": rows})

    # ----- things someone needs to chase -----
    today = date.today()
    unpaid = session.exec(select(Order).where(visible, INVOICED, Order.payment_received.is_not(True))
                          .order_by(Order.invoice_date)).all()
    to_invoice = session.exec(select(Order).where(visible, Order.po_number.is_not(None), Order.invoice_number.is_(None))).all()
    dc_pending = session.exec(select(Order).where(visible, Order.dc_number.is_not(None), Order.dc_received.is_not(True))).all()
    grn_pending = session.exec(select(Order).where(visible, INVOICED, Order.grn_done.is_(False))).all()

    # ----- quotation pipeline: quotes without a PO are still open -----
    open_quotes, open_value = session.exec(
        select(func.count(), total(Quotation.total_amount)).where(quotes, Quotation.po_number.is_(None))
    ).one()
    won_quotes, won_value = session.exec(
        select(func.count(), total(Quotation.po_amount)).where(quotes, Quotation.po_number.is_not(None))
    ).one()

    return {
        "kpis": {
            "orders": order_count,
            "invoices": invoiced_count,
            "invoiced_total": round(invoiced_total, 2),
            "received_total": round(received_total, 2),
            "outstanding_total": round(invoiced_total - received_total, 2),
            "open_quotes": open_quotes,
            "open_quotes_value": round(open_value, 2),
            "won_quotes": won_quotes,
            "won_quotes_value": round(won_value, 2),
        },
        "by_customer": by_customer,
        "by_firm": by_firm,
        "by_category": by_category,
        "by_month": by_month,
        "attention": {
            "unpaid_invoices": [
                {"id": o.id, "firm_id": o.firm_id, "customer": o.customer, "invoice_number": o.invoice_number,
                 "invoice_date": o.invoice_date, "description": o.description, "total_amount": o.total_amount,
                 "days_pending": (today - o.invoice_date).days if o.invoice_date else None}
                for o in unpaid
            ],
            "to_invoice": [_brief(o) for o in to_invoice],
            "dc_not_received": [_brief(o) for o in dc_pending],
            "grn_pending": [_brief(o) for o in grn_pending],
        },
    }


def _brief(o: Order) -> dict:
    return {"id": o.id, "firm_id": o.firm_id, "customer": o.customer, "po_number": o.po_number, "dc_number": o.dc_number,
            "invoice_number": o.invoice_number, "order_date": o.order_date, "description": o.description}
