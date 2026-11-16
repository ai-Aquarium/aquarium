"""Source tags on the channel SQLite DBs (FG-03 P2).

Every stored message carries the registry ``source_id`` it was read from and
its ``owner_user_id`` so the P4 router can find the source's routes. The
services open databases created long before these columns existed, so each
adds them on start; adding is idempotent.
"""

import sqlite3

SOURCE_COLUMNS = (("source_id", "TEXT"), ("owner_user_id", "TEXT"))


def ensure_source_columns(db: sqlite3.Connection, table: str) -> None:
    have = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
    if not have:
        return
    for name, kind in SOURCE_COLUMNS:
        if name not in have:
            try:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")
            except sqlite3.OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_source ON {table}(source_id)")
    db.commit()
