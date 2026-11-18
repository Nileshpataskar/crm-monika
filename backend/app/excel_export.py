"""Export orders and quotations to Excel, for backup.

The file uses the client's own column headings and one sheet per month ("MAY - 2026") or per
quotation year ("2026-27"), so a backup can be restored simply by uploading it again.
"""
from datetime import date
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .models import CustomField

# (Excel heading, field). Each heading maps back to the same field when the file is uploaded.
ORDER_EXPORT = [
    ("SR.NO.", None), ("CUSTOMER NAME", "customer"), ("ORDER DATE", "order_date"), ("VENDOR CODE", "vendor_code"),
    ("PR / PO NUMBER", "po_number"), ("PO EMAIL RECEIVED", "po_email_received"), ("DESCRIPTION", "description"),
    ("QTY", "qty"), ("UNIT", "unit"), ("CATEGORY", "category"), ("DELIVERY LOCATION", "delivery_location"),
    ("INDENTOR NAME", "indentor"), ("QUOTATION NUMBER", "quotation_number"), ("DELIVERY DATE", "delivery_date"),
    ("D C NO.", "dc_number"), ("D C RECEIPT", "dc_received"), ("INVOICE DATE", "invoice_date"),
    ("INVOICE NUMBER", "invoice_number"), ("JCC", "jcc"), ("AMOUNT", "amount"), ("CGST", "cgst"), ("SGST", "sgst"),
    ("TOTAL AMOUNT", "total_amount"), ("PRINT + STAMP", "print_stamp"), ("GRN", "grn_done"),
    ("PURCHASE BILL RECEIVED", "purchase_bill_received"), ("PAYMENT RECEIVED IN BANK", "payment_received"),
]
QUOTATION_EXPORT = [
    ("WORK LOCATION", "work_location"), ("SR.NO.", None), ("WORK TITLE", "work_title"), ("WORK TYPE", "work_type"),
    ("WORK COMPLETION STATUS", "work_completed"), ("QUOTE NO.", "quote_number"), ("WORK DATE", "work_date"),
    ("INDENTOR", "indentor"), ("TOTAL AMOUNT", "total_amount"), ("PR NUMBER", "pr_number"),
    ("WETHER BOOKED", "booked"), ("PO NUMBER", "po_number"), ("PO STATUS", "po_released"),
    ("PO AMOUNT", "po_amount"), ("PRINT + STAMP", "print_stamp"), ("INVOICE NO.", "invoice_number"),
    ("GRN", "grn_done"), ("MONEY RECEIVED IN BANK", "payment_received"),
]

# Yes/no columns use the same words as the client's dropdowns. Anything not listed: YES / NO.
BOOL_WORDS = {
    "orders": {"dc_received": ("RECEIVED", "NOT RECEIVED"), "grn_done": ("COMPLETE", "INCOMPLETE")},
    "quotations": {"work_completed": ("COMPLETED", "NOT COMPLETED"), "po_released": ("RELEASED", "NOT RELEASED"),
                   "booked": ("YES", "NOT YET")},
}
MONEY_FIELDS = {"amount", "cgst", "sgst", "total_amount", "po_amount"}

HEADER_FILL = PatternFill("solid", fgColor="23824F")
HEADER_FONT = Font(bold=True, color="FFFFFF")


def sheet_title(entity: str, period: str | None) -> str:
    """'2026-05' -> 'MAY - 2026' (the client's own naming); quotation years stay '2026-27'."""
    if entity == "orders" and period and len(period) == 7:
        year, month = period.split("-")
        return f"{date(int(year), int(month), 1).strftime('%B').upper()} - {year}"
    return (period or "Other")[:31].replace("/", "-")


def cell_value(entity: str, field: str, value):
    if isinstance(value, bool):
        yes, no = BOOL_WORDS[entity].get(field, ("YES", "NO"))
        return yes if value else no
    return value


def custom_cell(field: CustomField, value):
    if value is None:
        return None
    if field.type == "yesno":
        return "YES" if value else "NO"
    if field.type == "date":
        return date.fromisoformat(value)
    return value


def add_sheet(wb: Workbook, entity: str, title: str, rows: list, fields: list[CustomField]):
    ws = wb.create_sheet(title)
    columns = (ORDER_EXPORT if entity == "orders" else QUOTATION_EXPORT)
    ws.append([heading for heading, _ in columns] + [f.label.upper() for f in fields])
    for number, row in enumerate(rows, 1):
        values = [number if field is None else cell_value(entity, field, getattr(row, field)) for _, field in columns]
        values += [custom_cell(f, (row.extra or {}).get(f.key)) for f in fields]
        ws.append(values)

    # Formatting: green bold header, frozen header row, filter buttons, dates and rupees.
    for cell in ws[1]:
        cell.fill, cell.font = HEADER_FILL, HEADER_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    all_fields = [field for _, field in columns] + [None] * len(fields)
    for i, field in enumerate(all_fields, 1):
        letter = get_column_letter(i)
        longest = max((len(str(c.value)) for c in ws[letter] if c.value is not None), default=8)
        ws.column_dimensions[letter].width = min(max(longest + 2, 10), 50)
        for c in ws[letter][1:]:
            if isinstance(c.value, date):
                c.number_format = "DD-MM-YYYY"
            elif field in MONEY_FIELDS:
                c.number_format = "#,##0.00"


def build_workbook(sheets: list[tuple[str, str | None, list]], fields: dict[str, list[CustomField]]) -> bytes:
    """sheets: (entity, period, rows) in the order they should appear."""
    wb = Workbook()
    wb.remove(wb.active)
    for entity, period, rows in sheets:
        add_sheet(wb, entity, sheet_title(entity, period), rows, fields.get(entity, []))
    if not wb.worksheets:
        wb.create_sheet("No data").append(["Nothing to export yet"])
    out = BytesIO()
    wb.save(out)
    return out.getvalue()
