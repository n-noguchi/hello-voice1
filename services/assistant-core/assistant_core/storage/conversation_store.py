from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from assistant_core.config import default_data_dir
from assistant_core.schemas import Message, StoredMessage


class ConversationStore:
    def __init__(self, db_path: Path | None = None) -> None:
        data_dir = default_data_dir()
        data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path or data_dir / "conversation.sqlite3"
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                create table if not exists messages (
                  id integer primary key autoincrement,
                  session_id text not null,
                  role text not null,
                  content text not null,
                  created_at text not null
                )
                """
            )
            conn.execute(
                "create index if not exists idx_messages_session_id on messages(session_id, id)"
            )

    def add_message(self, session_id: str, message: Message) -> StoredMessage:
        created_at = datetime.now(timezone.utc)
        with self._connect() as conn:
            cursor = conn.execute(
                """
                insert into messages(session_id, role, content, created_at)
                values (?, ?, ?, ?)
                """,
                (session_id, message.role, message.content, created_at.isoformat()),
            )
            row_id = int(cursor.lastrowid)
        return StoredMessage(
            id=row_id,
            session_id=session_id,
            role=message.role,
            content=message.content,
            created_at=created_at,
        )

    def list_messages(self, session_id: str, limit: int = 30) -> list[StoredMessage]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                select id, session_id, role, content, created_at
                from messages
                where session_id = ?
                order by id desc
                limit ?
                """,
                (session_id, limit),
            ).fetchall()
        messages: list[StoredMessage] = []
        for row in reversed(rows):
            messages.append(
                StoredMessage(
                    id=int(row["id"]),
                    session_id=str(row["session_id"]),
                    role=row["role"],
                    content=row["content"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                )
            )
        return messages

    def clear(self, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute("delete from messages where session_id = ?", (session_id,))


conversation_store = ConversationStore()
