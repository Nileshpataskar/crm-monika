"""Database tables. Each class = one table, each attribute = one column.

Money is stored as float to keep the prototype simple on SQLite. When we move to
PostgreSQL, switch money columns to Decimal (Numeric) so paise never get rounded wrong.
"""
from datetime import date, datetime, timezone

from pydantic import field_serializer
from sqlalchemy import JSON, Column, LargeBinary
from sqlmodel import Field, SQLModel


class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    username: str = Field(unique=True, index=True)
    full_name: str
    password_hash: str  # never the password itself, see auth.hash_password
    role: str = "viewer"  # "admin" can upload and manage users, "viewer" can only look
    is_active: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserPublic(SQLModel):
    """What the API sends back about a user: everything except the password hash."""
    id: int
    username: str
    full_name: str
    role: str
    is_active: bool


class Firm(SQLModel, table=True):
    """A business the client runs (they have more than one). Every order, quotation and upload
    belongs to one firm. Details are optional and can be filled in later."""
    id: int | None = Field(default=None, primary_key=True)
    name: str
    position: int = 0  # order in the menu
    gstin: str | None = None  # 15-character GST number, e.g. 27ABCDE1234F1Z5
    contact_person: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    notes: str | None = None
    # Set when the admin archives the firm: it leaves the menus and the dashboard, its data is kept.
    archived_at: datetime | None = None

    @field_serializer("archived_at")
    def as_utc(self, value: datetime | None) -> str | None:
        """Stored without a timezone (see Upload.as_utc), so say explicitly that it's UTC."""
        return value.replace(tzinfo=value.tzinfo or timezone.utc).isoformat() if value else None


class Upload(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    firm_id: int | None = Field(default=None, foreign_key="firm.id", index=True)
    filename: str
    uploaded_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    orders_imported: int = 0
    quotations_imported: int = 0
    stored_file: str | None = None  # older uploads: the copy on disk. Newer ones are in StoredFile.

    @field_serializer("uploaded_at")
    def as_utc(self, value: datetime) -> str:
        """SQLite forgets the timezone when it stores a datetime, so say explicitly that it's UTC."""
        return value.replace(tzinfo=value.tzinfo or timezone.utc).isoformat()


class Order(SQLModel, table=True):
    """One row of the PO summary sheet: a PO line / job and its billing status."""
    id: int | None = Field(default=None, primary_key=True)
    firm_id: int | None = Field(default=None, foreign_key="firm.id", index=True)
    upload_id: int | None = Field(default=None, foreign_key="upload.id")  # NULL = typed into the app
    sheet_name: str
    period: str | None = Field(default=None, index=True)  # "2026-05": re-uploading a month replaces it
    # Set when a later month's sheet has the same order: this older copy is then hidden, not deleted,
    # so it comes back if that later month is deleted. NULL = visible.
    replaced_by_period: str | None = Field(default=None, index=True)
    excel_row: int

    customer: str | None = Field(default=None, index=True)
    order_date: date | None = None
    vendor_code: str | None = None
    po_number: str | None = Field(default=None, index=True)
    po_email_received: bool | None = None
    description: str | None = None
    qty: float | None = None
    unit: str | None = None
    category: str | None = None
    delivery_location: str | None = None
    indentor: str | None = None
    quotation_number: str | None = None
    delivery_date: date | None = None
    dc_number: str | None = None
    dc_received: bool | None = None
    invoice_date: date | None = None
    invoice_number: str | None = None
    jcc: str | None = None
    amount: float | None = None
    cgst: float | None = None
    sgst: float | None = None
    total_amount: float | None = None
    print_stamp: bool | None = None
    grn_done: bool | None = None
    purchase_bill_received: bool | None = None
    payment_received: bool | None = None
    # Values of the admin-defined custom columns, e.g. {"site_engineer": "Ravi"}. See CustomField.
    extra: dict | None = Field(default=None, sa_column=Column(JSON))


class Quotation(SQLModel, table=True):
    """One row of the quotations sheet."""
    id: int | None = Field(default=None, primary_key=True)
    firm_id: int | None = Field(default=None, foreign_key="firm.id", index=True)
    upload_id: int | None = Field(default=None, foreign_key="upload.id")  # NULL = typed into the app
    sheet_name: str
    period: str | None = Field(default=None, index=True)  # financial year, e.g. "2026-27"
    excel_row: int

    work_location: str | None = None
    quote_number: str | None = Field(default=None, index=True)
    work_title: str | None = None
    work_type: str | None = None
    work_completed: bool | None = None
    work_date: date | None = None
    indentor: str | None = None
    total_amount: float | None = None
    pr_number: str | None = None
    booked: bool | None = None
    po_number: str | None = Field(default=None, index=True)  # links to Order.po_number
    po_released: bool | None = None
    po_amount: float | None = None
    print_stamp: bool | None = None
    invoice_number: str | None = None
    grn_done: bool | None = None
    payment_received: bool | None = None
    extra: dict | None = Field(default=None, sa_column=Column(JSON))


class CustomField(SQLModel, table=True):
    """An extra column the admin added to Orders or Quotations. Values live in each row's `extra`."""
    id: int | None = Field(default=None, primary_key=True)
    entity: str = Field(index=True)  # "orders" or "quotations"
    key: str  # "site_engineer": the key in `extra`, and how a matching Excel header is recognised
    label: str  # "Site Engineer": shown in the app and used as the Excel export header
    type: str = "text"  # "text", "number", "date" or "yesno"
    position: int = 0  # order of the columns


class ColumnLayout(SQLModel, table=True):
    """The order of the columns in the Orders or Quotations table, as the admin arranged them.
    Built-in columns by name ("po_number"), custom columns as "custom:<id>"."""
    entity: str = Field(primary_key=True)  # "orders" or "quotations"
    columns: list = Field(default_factory=list, sa_column=Column(JSON, nullable=False))


class WorkLocation(SQLModel, table=True):
    """A work location offered in the quotation form and filter (MCD 1, FMD 4, KOMATSU, ...)."""
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True)


class StoredFile(SQLModel, table=True):
    """The original uploaded Excel file, kept in the database so it can be viewed and downloaded
    later. (Free hosting has no lasting disk, so files can't be kept in a folder there.)
    A separate table so listing uploads doesn't load every file's bytes."""
    upload_id: int = Field(primary_key=True, foreign_key="upload.id")
    data: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
