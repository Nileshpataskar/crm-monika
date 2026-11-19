"""Copy everything from this computer's database (crm.db) into another one, e.g. Neon:

    python -m app.copy_data "postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require"

The target must be empty. Excel files of older uploads that are still in uploads/ go into the
database too, so they can be viewed online. Nothing in crm.db is changed apart from bringing its
tables up to date (the same update the app does when it starts).
"""
import os
import sys
from pathlib import Path

from sqlalchemy import func, select, text
from sqlmodel import SQLModel

from . import models  # noqa: F401  (registers the tables)
from .db import create_tables, engine, engine_for
from .models import ColumnLayout, CustomField, Firm, Order, Quotation, StoredFile, Upload, User, WorkLocation

# Parents before children, because of the foreign keys (an order points at its upload).
TABLES = [User, Firm, Upload, CustomField, ColumnLayout, WorkLocation, Order, Quotation, StoredFile]
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))


def main(target_url: str):
    create_tables()  # make sure the local database has every current column
    target = engine_for(target_url)
    SQLModel.metadata.create_all(target)

    with engine.connect() as src, target.begin() as dst:
        if dst.execute(select(func.count()).select_from(User.__table__)).scalar():
            sys.exit("The target database already has data. Use an empty one.")

        for model in TABLES:
            table = model.__table__
            rows = [dict(r) for r in src.execute(table.select()).mappings()]
            if rows:
                dst.execute(table.insert(), rows)
            print(f"  {table.name:12} {len(rows)} rows")

        # Older uploads kept their Excel file on disk: put those files in the database as well.
        have_file = {r[0] for r in dst.execute(select(StoredFile.__table__.c.upload_id))}
        moved = 0
        for upload_id, stored in src.execute(select(Upload.__table__.c.id, Upload.__table__.c.stored_file)):
            path = UPLOAD_DIR / stored if stored else None
            if upload_id not in have_file and path and path.is_file():
                dst.execute(StoredFile.__table__.insert(), {"upload_id": upload_id, "data": path.read_bytes()})
                moved += 1
        print(f"  files from {UPLOAD_DIR}/: {moved}")

        # PostgreSQL hands out new ids from a counter. We inserted our own ids, so move the counter on.
        if dst.dialect.name == "postgresql":
            for model in TABLES:
                if model in (StoredFile, ColumnLayout):  # no id counter
                    continue
                name = model.__table__.name
                dst.execute(text(f"SELECT setval(pg_get_serial_sequence('\"{name}\"', 'id'), "
                                 f"COALESCE((SELECT MAX(id) FROM \"{name}\"), 0) + 1, false)"))
    print("Done.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
