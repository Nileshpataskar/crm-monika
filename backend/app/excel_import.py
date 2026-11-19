"""Turn the client's Excel workbooks into clean rows ready for the database.

For every sheet in an uploaded workbook:
  1. find the data range   (the Excel Table if there is one, so pivots/totals below it are ignored)
  2. detect the sheet type (PO summary or quotations) from its headers
  3. rename columns        (messy Excel headers -> our field names)
  4. drop junk rows        (blank rows, TOTAL rows, empty location sections)
  5. convert types         ("YES " -> True, 4601545200 -> "4601545200", dates, money)
"""
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from io import BytesIO

import openpyxl
from openpyxl.utils.cell import range_boundaries
import pandas as pd


def snake(header) -> str:
    """'PR / PO NUMBER' -> 'pr_po_number', 'QUOTATION\\nNUMBER' -> 'quotation_number'."""
    return re.sub(r"[^a-z0-9]+", "_", str(header).strip().lower()).strip("_")


# snake(excel header) -> our field name. Headers not listed here are ignored.
ORDER_COLUMNS = {
    "customer_name": "customer",
    "order_date": "order_date",
    "vendor_code": "vendor_code",
    "pr_po_number": "po_number",
    "po_email_received": "po_email_received",
    "description": "description",
    "qty": "qty",
    "unit": "unit",
    "category": "category",
    "delivery_location": "delivery_location",
    "indentor_name": "indentor",
    "quotation_number": "quotation_number",
    "delivery_date": "delivery_date",
    "d_c_no": "dc_number",
    "d_c_receipt": "dc_received",
    "invoice_date": "invoice_date",
    "invoice_number": "invoice_number",
    "jcc": "jcc",
    "amount": "amount",
    "cgst": "cgst",
    "sgst": "sgst",
    "total_amount": "total_amount",
    "print_stamp": "print_stamp",
    "grn": "grn_done",
    "purchase_bill_received": "purchase_bill_received",
    "payment_received_in_bank": "payment_received",
}

QUOTATION_COLUMNS = {
    "work_location": "work_location",
    "work_title": "work_title",
    "work_type": "work_type",
    "work_completion_status": "work_completed",
    "quote_no": "quote_number",
    "work_date": "work_date",
    "indentor": "indentor",
    "total_amount": "total_amount",
    "pr_number": "pr_number",
    "wether_booked": "booked",
    "po_number": "po_number",
    "po_status": "po_released",
    "po_amount": "po_amount",
    "print_stamp": "print_stamp",
    "invoice_no": "invoice_number",
    "grn": "grn_done",
    "money_received_in_bank": "payment_received",
}

# A sheet is recognised by having all of these headers.
SIGNATURES = {
    "orders": {"customer_name", "pr_po_number", "invoice_number"},
    "quotations": {"work_title", "quote_no"},
}

TEXT_FIELDS = {"customer", "description", "unit", "category", "delivery_location", "indentor",
               "work_location", "work_title", "work_type"}
CODE_FIELDS = {"vendor_code", "po_number", "quotation_number", "dc_number", "invoice_number",
               "jcc", "quote_number", "pr_number"}
DATE_FIELDS = {"order_date", "delivery_date", "invoice_date", "work_date"}
NUMBER_FIELDS = {"qty", "amount", "cgst", "sgst", "total_amount", "po_amount"}
BOOL_FIELDS = {"po_email_received", "dc_received", "print_stamp", "grn_done",
               "purchase_bill_received", "payment_received", "work_completed", "booked",
               "po_released"}

# Every value the client's dropdowns allow, mapped to True/False. "NA" and blanks become None.
TRUE_WORDS = {"YES", "RECEIVED", "COMPLETE", "COMPLETED", "RELEASED"}
FALSE_WORDS = {"NO", "NOT RECEIVED", "INCOMPLETE", "NOT COMPLETED", "NOT RELEASED", "NOT YET"}
NULL_WORDS = {"", "NA", "N/A", "-"}


@dataclass
class SheetResult:
    sheet_name: str
    kind: str | None  # "orders", "quotations", or None when we don't recognise the sheet
    period: str | None = None  # "2026-05" for a monthly PO sheet, "2026-27" for a quotation year sheet
    rows: list[dict] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)  # quotation sheets: every location block, even empty ones
    warnings: list[str] = field(default_factory=list)  # imported anyway, but worth checking
    errors: list[str] = field(default_factory=list)  # this sheet can't be imported until fixed


# ---------- which month / year a sheet belongs to ----------

MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def period_from_sheet_name(name: str) -> str | None:
    """'MAY - 2026' -> '2026-05'. Also understands 'June 2026', 'Jun-26', '2026-06' and '06/2026'."""
    text = name.upper()
    numeric = re.search(r"\b(20\d{2})[-/ ](\d{1,2})\b", text) or re.search(r"\b(\d{1,2})[-/ ](20\d{2})\b", text)
    if numeric:
        a, b = numeric.groups()
        year, month = (int(a), int(b)) if len(a) == 4 else (int(b), int(a))
        return f"{year}-{month:02d}" if 1 <= month <= 12 else None

    month = next((i for i, m in enumerate(MONTHS, 1) if re.search(rf"\b{m}[A-Z]*\b", text)), None)
    if month is None:
        return None
    year = re.search(r"\b(20\d{2})\b", text) or re.search(r"\b(\d{2})\b", text)
    return f"{2000 + int(year.group(1)) % 100}-{month:02d}" if year else None


def period_from_dates(df: pd.DataFrame) -> str | None:
    """Fallback when the sheet name has no month: the most common invoice (or order) month."""
    for col in ("invoice_date", "order_date"):
        months = [d.strftime("%Y-%m") for d in df[col] if isinstance(d, date)]
        if months:
            return max(set(months), key=months.count)
    return None


def period_label(period: str | None) -> str:
    """'2026-05' -> 'May 2026', '2026-27' -> 'FY 2026-27'."""
    if not period:
        return "Unknown"
    match = re.fullmatch(r"(\d{4})-(\d{2})", period)
    if not match:
        return period
    year, part = match.groups()
    return date(int(year), int(part), 1).strftime("%B %Y") if 1 <= int(part) <= 12 else f"FY {period}"


def financial_year(name: str) -> str:
    """Quotation sheets are per financial year: '2026-27' stays '2026-27', anything else is kept as-is."""
    match = re.search(r"(20\d{2})\s*-\s*(\d{2})", name)
    return f"{match.group(1)}-{match.group(2)}" if match else name.strip()


# ---------- single-value converters ----------

def to_text(value):
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()  # also turns "MCD 2, 3\n" into "MCD 2, 3"
    return text or None


def to_code(value):
    """IDs like PO numbers are text, not numbers: we never do maths on them and
    they can contain letters ('SS/25-26/167'). Also stops 4601545200 becoming '4601545200.0'."""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return to_text(value)


def to_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = to_text(value)
    if text is None:
        return None
    parsed = pd.to_datetime(text, dayfirst=True, errors="coerce")  # Indian dates are DD-MM-YYYY
    return None if pd.isna(parsed) else parsed.date()


def to_number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = to_text(value)
    if text is None:
        return None
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return None


def to_bool(value):
    text = (to_text(value) or "").upper()
    if text in TRUE_WORDS:
        return True
    if text in FALSE_WORDS:
        return False
    if text in NULL_WORDS:
        return None
    raise ValueError(f"unexpected value {value!r}")


# ---------- sheet-level steps ----------

def table_cells(ws) -> tuple:
    """The rows of the sheet's Excel Table (header first). Without a Table: from the top until
    the first completely blank row. This is how totals, pivots and dropdown lists below are skipped."""
    if ws.tables:
        min_col, min_row, max_col, max_row = range_boundaries(next(iter(ws.tables.values())).ref)  # "A1:AA17"
        # A column typed just right of the table (e.g. a new custom column) may not have been added
        # to the table itself. Include every column whose header cell next to the table is filled.
        while ws.cell(row=min_row, column=max_col + 1).value is not None:
            max_col += 1
        return tuple(ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col))
    cells = []
    for row in ws.iter_rows():
        if cells and all(c.value is None for c in row):
            break
        cells.append(row)
    return tuple(cells)


def read_sheet(ws) -> pd.DataFrame:
    """Read the sheet's Excel Table into a DataFrame. Each row remembers its Excel row number."""
    cells = table_cells(ws)
    if not cells:
        return pd.DataFrame()
    first_row = cells[0][0].row
    headers = [snake(c.value) if c.value is not None else f"col_{i}" for i, c in enumerate(cells[0])]
    data = [[c.value for c in row] for row in cells[1:]]
    # dtype=object keeps Excel's values as-is; we convert types ourselves below.
    df = pd.DataFrame(data, columns=headers, dtype=object)
    df["excel_row"] = range(first_row + 1, first_row + 1 + len(df))
    return df


def display_value(value) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%d-%m-%Y")
    if isinstance(value, float):
        return f"{value:,.2f}".rstrip("0").rstrip(".") if not value.is_integer() else str(int(value))
    return str(value).strip()


def workbook_grid(content: bytes, max_rows: int = 2000) -> list[dict]:
    """The data area of every sheet as plain text, for showing the uploaded file in the browser."""
    wb = openpyxl.load_workbook(BytesIO(content), data_only=True)
    sheets = []
    for ws in wb.worksheets:
        cells = table_cells(ws)
        if not cells:
            sheets.append({"name": ws.title, "headers": [], "rows": []})
            continue
        headers = [display_value(c.value) for c in cells[0]]
        rows = []
        for row in cells[1:]:
            values = [display_value(c.value) for c in row]
            if any(values):  # skip blank rows
                rows.append({"excel_row": row[0].row, "cells": values})
        sheets.append({"name": ws.title, "headers": headers, "rows": rows[:max_rows], "truncated": len(rows) > max_rows})
    return sheets


def detect_kind(columns) -> str | None:
    for kind, required in SIGNATURES.items():
        if required.issubset(columns):
            return kind
    return None


def convert_types(df: pd.DataFrame, warnings: list[str]) -> pd.DataFrame:
    for col in df.columns:
        if col in TEXT_FIELDS:
            df[col] = df[col].map(to_text)
        elif col in CODE_FIELDS:
            df[col] = df[col].map(to_code)
        elif col in DATE_FIELDS:
            df[col] = df[col].map(to_date)
        elif col in NUMBER_FIELDS:
            df[col] = df[col].map(to_number)
        elif col in BOOL_FIELDS:
            df[col] = [_bool_or_warn(v, col, row, warnings) for v, row in zip(df[col], df["excel_row"])]
    return df


def _bool_or_warn(value, col, excel_row, warnings):
    try:
        return to_bool(value)
    except ValueError as e:
        warnings.append(f"Row {excel_row}, {col}: {e}, stored as blank")
        return None


IGNORED_HEADERS = {"sr_no", "excel_row"}  # serial numbers are just row counters


def custom_value(value, field_type: str):
    """Convert a cell for an admin-defined column. Stored as JSON, so dates become 'YYYY-MM-DD'."""
    if field_type == "number":
        return to_number(value)
    if field_type == "date":
        d = to_date(value)
        return d.isoformat() if d else None
    if field_type == "yesno":
        try:
            return to_bool(value)
        except ValueError:
            return None
    return to_text(value)


def select_columns(df: pd.DataFrame, mapping: dict, warnings: list[str], custom: list[dict]) -> pd.DataFrame:
    """Rename the headers we know and keep only those. A missing column becomes blank, with a warning.
    Columns matching a custom column (same name) go into `extra`; any other column is reported."""
    missing = [header for header in mapping if header not in df.columns]
    if missing:
        names = ", ".join(header.replace("_", " ").upper() for header in missing)
        warnings.append(f"Column(s) not found, left blank: {names}")

    found = [f for f in custom if f["key"] in df.columns]
    known = set(mapping) | IGNORED_HEADERS | {f["key"] for f in found}
    unknown = [c for c in df.columns if c not in known and not c.startswith("col_")]
    if unknown:
        names = ", ".join(c.replace("_", " ").upper() for c in unknown)
        warnings.append(f"Column(s) not imported: {names}. To keep them, add a custom column with the same name in the app, then upload again.")

    extra = []
    for _, row in df.iterrows():
        values = {f["key"]: custom_value(row[f["key"]], f["type"]) for f in found}
        values = {k: v for k, v in values.items() if v is not None}
        extra.append(values or None)

    df = df.rename(columns=mapping)
    for col in mapping.values():
        if col not in df.columns:
            df[col] = [None] * len(df)
    df["extra"] = extra
    return df[[*mapping.values(), "extra", "excel_row"]]


def clean_orders(df: pd.DataFrame, warnings: list[str], custom: list[dict] = ()) -> pd.DataFrame:
    df = select_columns(df, ORDER_COLUMNS, warnings, list(custom))
    df = convert_types(df, warnings)

    # A real order line has at least a customer or a description.
    df = df[df["customer"].notna() | df["description"].notna()]
    df = df[~df["customer"].fillna("").str.upper().isin(["TOTAL", "GRAND TOTAL"])]

    # GST: the Excel formula is AMOUNT * 9% for each of CGST and SGST. Use Excel's value when
    # present, otherwise compute it, and leave tax blank when there is no amount yet.
    # These work on whole columns at once; a missing number in pandas is NaN, not None.
    has_amount = df["amount"].notna()
    nine_percent = (df["amount"] * 0.09).round(2)
    df["cgst"] = df["cgst"].fillna(nine_percent).round(2).where(has_amount)
    df["sgst"] = df["sgst"].fillna(nine_percent).round(2).where(has_amount)
    df["total_amount"] = (df["amount"] + df["cgst"] + df["sgst"]).round(2)

    for _, row in df.iterrows():
        if pd.isna(row["order_date"]):
            warnings.append(f"Row {row['excel_row']}: no order date ({row['description']})")
        if pd.notna(row["invoice_number"]) and pd.isna(row["amount"]):
            warnings.append(f"Row {row['excel_row']}: invoice {row['invoice_number']} has no amount")
        if pd.notna(row["amount"]) and row["amount"] < 0:
            warnings.append(f"Row {row['excel_row']}: amount is negative ({row['amount']})")
        if row["payment_received"] is True and pd.isna(row["invoice_number"]):
            warnings.append(f"Row {row['excel_row']}: marked as paid but has no invoice number")
        ordered, invoiced = row["order_date"], row["invoice_date"]
        if isinstance(ordered, date) and isinstance(invoiced, date) and invoiced < ordered:
            warnings.append(f"Row {row['excel_row']}: invoice date {invoiced:%d %b %Y} is before the order date {ordered:%d %b %Y}")
    return df


def location_names(df: pd.DataFrame) -> list[str]:
    """Every location block in the sheet, including ones with no quotations yet (KOMATSU, KCPTL...)."""
    names = [to_text(v) for v in df["work_location"]] if "work_location" in df.columns else []
    return list(dict.fromkeys(n for n in names if n and n.upper() not in ("TOTAL", "GRAND TOTAL")))


def clean_quotations(df: pd.DataFrame, warnings: list[str], custom: list[dict] = ()) -> pd.DataFrame:
    df = select_columns(df, QUOTATION_COLUMNS, warnings, list(custom))
    # The location is written once at the top of each block ("MCD 1", "FMD 4", ...),
    # so copy it down to every row of the block.
    df["work_location"] = df["work_location"].ffill()
    df = convert_types(df, warnings)

    # Drops TOTAL rows and the empty FMD / KOMATSU / KCPTL blocks.
    df = df[df["work_title"].notna()]

    dupes = df[df["quote_number"].notna() & df["quote_number"].duplicated(keep=False)]
    for quote_number in dupes["quote_number"].unique():
        warnings.append(f"Quote number {quote_number} appears more than once")
    return df


def records(df: pd.DataFrame) -> list[dict]:
    """DataFrame -> list of plain dicts, with pandas' NaN turned into None."""
    df = df.astype(object).where(df.notna(), None)
    return df.to_dict(orient="records")


def parse_workbook(content: bytes, custom_fields: dict | None = None) -> list[SheetResult]:
    """custom_fields: {"orders": [{"key": ..., "type": ...}], "quotations": [...]} from the CustomField table."""
    custom_fields = custom_fields or {}
    # data_only=True gives us the values Excel calculated, not the formulas.
    wb = openpyxl.load_workbook(BytesIO(content), data_only=True)
    results = []
    for ws in wb.worksheets:
        df = read_sheet(ws)
        result = SheetResult(sheet_name=ws.title, kind=detect_kind(df.columns))
        if result.kind == "orders":
            cleaned = clean_orders(df, result.warnings, custom_fields.get("orders", []))
            result.rows = records(cleaned)
            # Each PO summary sheet is one month. Read it from the name, or failing that from the dates.
            result.period = period_from_sheet_name(ws.title)
            if result.period is None:
                result.period = period_from_dates(cleaned)
                if result.period:
                    result.warnings.insert(0, f"No month in the sheet name '{ws.title}', "
                                              f"so using {period_label(result.period)} from the invoice/order dates")
                else:
                    result.errors.append(f"Can't tell which month '{ws.title}' is for. "
                                         "Rename the sheet like 'JUNE - 2026'.")
        elif result.kind == "quotations":
            result.locations = location_names(df)
            result.rows = records(clean_quotations(df, result.warnings, custom_fields.get("quotations", [])))
            result.period = financial_year(ws.title)
        else:
            result.warnings.append("Not a PO summary or quotation sheet, skipped")
        if result.kind and not result.rows:
            result.errors.append("No data rows found in this sheet")
        results.append(result)
    return results
