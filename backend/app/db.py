"""Database engine, ids and timestamps.

SQLite in WAL mode (docs/03): one machine, one worker writing events, a few readers.
Every connection gets the same pragmas, because SQLite pragmas are per-connection and
foreign keys are OFF by default.

Ids are UUIDv7 text: unique without coordination, and they sort by creation time, so
"newest first" needs no extra column. Timestamps are ISO-8601 UTC text with a Z.
"""

import os
import threading
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import DeclarativeBase

BUSY_TIMEOUT_MS = 5000


class Base(DeclarativeBase):
    pass


_id_lock = threading.Lock()
_last_id = 0
_RAND_BITS = 74  # 12 bits rand_a + 62 bits rand_b


def _compose(millis: int, rand: int) -> int:
    rand_a, rand_b = rand >> 62, rand & ((1 << 62) - 1)
    return (millis << 80) | (0x7 << 76) | (rand_a << 64) | (0x2 << 62) | rand_b


def new_id() -> str:
    """A UUIDv7 string: 48-bit unix-ms timestamp, version 7, RFC 4122 variant.

    Strictly increasing within this process: two ids made in the same millisecond
    increment the random part instead of re-rolling it, so ordering by id always
    matches creation order (the job queue's "oldest first" depends on it).
    """
    global _last_id
    millis = (time.time_ns() // 1_000_000) & 0xFFFF_FFFF_FFFF
    with _id_lock:
        last_millis = _last_id >> 80
        if millis <= last_millis:
            last_rand = ((_last_id >> 64) & 0xFFF) << 62 | (_last_id & ((1 << 62) - 1))
            millis, rand = last_millis, last_rand + 1
        else:
            rand = int.from_bytes(os.urandom(10), "big") >> (80 - _RAND_BITS)
            rand &= (1 << (_RAND_BITS - 1)) - 1  # leave headroom for increments
        _last_id = _compose(millis, rand)
        return str(uuid.UUID(int=_last_id))


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _set_pragmas(dbapi_connection: Any, _: Any) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def make_engine(url: str) -> Engine:
    engine = create_engine(url)
    event.listen(engine, "connect", _set_pragmas)
    return engine
