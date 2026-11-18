import os
import re

from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

# SQLite (a single file) locally. Online, DATABASE_URL points at PostgreSQL, e.g. the string Neon
# gives you: postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///crm.db")
if os.getenv("VERCEL") and DATABASE_URL.startswith("sqlite"):
    raise RuntimeError("DATABASE_URL is not set. Add your Neon connection string in Vercel: "
                       "Project → Settings → Environment Variables, then deploy again.")


def engine_for(url: str):
    if url.startswith("sqlite"):
        return create_engine(url, connect_args={"check_same_thread": False})
    # Hosts hand out "postgres://..." or "postgresql://..."; SQLAlchemy needs to be told the driver.
    url = re.sub(r"^postgres(ql)?://", "postgresql+psycopg://", url)
    # Keep a couple of connections open and reuse them: opening a new one (encryption + login) costs
    # several round trips. pre_ping replaces connections the server closed while the app was idle
    # (Neon closes them when it pauses), recycle drops them after 5 minutes anyway.
    return create_engine(url, pool_size=2, max_overflow=4, pool_pre_ping=True, pool_recycle=300)


engine = engine_for(DATABASE_URL)


_tables_ready = False


def create_tables():
    """Create missing tables and bring existing ones up to date. On Vercel the app can start many
    times a day; this only needs to run once per running copy, so later starts skip it."""
    global _tables_ready
    if _tables_ready:
        return
    SQLModel.metadata.create_all(engine)
    add_missing_columns()
    _tables_ready = True


def add_missing_columns():
    """create_all() makes new tables but never changes existing ones. This brings existing tables
    up to date with models.py: columns that became optional, new columns (they must allow NULL),
    and the `period` column filled in. A bigger project would use Alembic migrations for this."""
    from .excel_import import financial_year, period_from_sheet_name

    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            make_columns_optional(conn, table)

    inspector = inspect(engine)
    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            existing = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name not in existing:
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {column.type.compile(engine.dialect)}'))

        for table, to_period in (("order", period_from_sheet_name), ("quotation", financial_year)):
            sheets = conn.execute(text(f'SELECT DISTINCT sheet_name FROM "{table}" WHERE period IS NULL')).scalars()
            for sheet in list(sheets):
                conn.execute(text(f'UPDATE "{table}" SET period = :p WHERE sheet_name = :s'),
                             {"p": to_period(sheet), "s": sheet})


def make_columns_optional(conn, table):
    """A column that allows NULL in models.py but is NOT NULL in the database (e.g. upload_id, once
    rows could be typed into the app). PostgreSQL can change that in place; SQLite can't, so the
    table is rebuilt: rename the old one, create it fresh from models.py, copy the rows across."""
    inspector = inspect(conn)
    existing = {c["name"]: c for c in inspector.get_columns(table.name)}
    stricter = [c.name for c in table.columns if c.nullable and c.name in existing and not existing[c.name]["nullable"]]
    if not stricter:
        return
    if conn.dialect.name != "sqlite":
        for name in stricter:
            conn.execute(text(f'ALTER TABLE "{table.name}" ALTER COLUMN "{name}" DROP NOT NULL'))
        return
    for index in inspector.get_indexes(table.name):  # the new table's indexes reuse these names
        conn.execute(text(f'DROP INDEX "{index["name"]}"'))
    conn.execute(text(f'ALTER TABLE "{table.name}" RENAME TO "{table.name}__old"'))
    table.create(conn)
    shared = ", ".join(f'"{name}"' for name in existing if name in table.columns)
    conn.execute(text(f'INSERT INTO "{table.name}" ({shared}) SELECT {shared} FROM "{table.name}__old"'))
    conn.execute(text(f'DROP TABLE "{table.name}__old"'))


def get_session():
    """FastAPI dependency: opens a DB session per request and closes it afterwards."""
    with Session(engine) as session:
        yield session
