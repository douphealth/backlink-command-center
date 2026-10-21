"""Shared, fail-closed operator controls and durable worker command queue.

Kept identical in dashboard and worker packages (checked in tests). No billable
API call, email send, or network access originates in this module.
"""
from __future__ import annotations
from datetime import datetime, timezone
import json
import sqlite3

CONTROLS = {
    'research_paused': False,
    'outreach_paused': True,
    'dataforseo_paused': True,
}
ACTIONS = {
    'research': 'Run evidence-based research once',
    'verify': 'Verify up to ten candidate pages',
    'audit_assets': 'Verify up to ten portfolio resources',
    'check_links': 'Recheck up to fifteen reported link placements',
    'monitor': 'Check existing outreach replies',
    'weekly': 'Review placements and draft allowed follow-ups',
}
SCHEMA = '''
CREATE TABLE IF NOT EXISTS operator_controls (
 key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value IN (0,1)),
 updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_status (
 id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT,
 last_seen_at TEXT, last_action TEXT, last_research_at TEXT,
 last_monitor_at TEXT, last_error TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS worker_commands (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 requested_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 requested_by TEXT NOT NULL DEFAULT 'dashboard',
 outcome TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_worker_commands_status
 ON worker_commands(status,requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_commands_dedupe
 ON worker_commands(action) WHERE status IN ('queued','running');
'''


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def ensure(db: sqlite3.Connection) -> None:
    db.executescript(SCHEMA)
    for name, enabled in CONTROLS.items():
        db.execute('INSERT OR IGNORE INTO operator_controls(key,value,updated_at,updated_by) VALUES(?,?,?,?)',
                   (name, int(enabled), now(), 'safe_default'))
    db.commit()


def flag(db: sqlite3.Connection, key: str) -> bool:
    if key not in CONTROLS:
        raise KeyError(key)
    row = db.execute('SELECT value FROM operator_controls WHERE key=?', (key,)).fetchone()
    return bool(row[0]) if row is not None else CONTROLS[key]


def flags(db: sqlite3.Connection) -> dict[str, bool]:
    return {key: flag(db, key) for key in CONTROLS}


def set_flag(db: sqlite3.Connection, key: str, value: bool, who: str = 'dashboard') -> None:
    if key not in CONTROLS or type(value) is not bool:
        raise ValueError('Unsupported control value')
    db.execute('INSERT INTO operator_controls(key,value,updated_at,updated_by) VALUES(?,?,?,?) '
               'ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
               (key, int(value), now(), who))


def enqueue(db: sqlite3.Connection, action: str) -> tuple[int, bool]:
    if action not in ACTIONS:
        raise ValueError('Unsupported worker action')
    row = db.execute("SELECT id FROM worker_commands WHERE action=? AND status IN ('queued','running')",
                     (action,)).fetchone()
    if row:
        return int(row[0]), False
    try:
        cur = db.execute('INSERT INTO worker_commands(action,status,requested_at) VALUES(?,?,?)',
                         (action, 'queued', now()))
        return int(cur.lastrowid), True
    except sqlite3.IntegrityError:
        row = db.execute("SELECT id FROM worker_commands WHERE action=? AND status IN ('queued','running')", (action,)).fetchone()
        if not row:
            raise
        return int(row[0]), False


def claim(db: sqlite3.Connection):
    # Caller owns single active worker lock. IMMEDIATE prevents a second worker
    # from claiming the same command under a race.
    db.execute('BEGIN IMMEDIATE')
    try:
        row = db.execute("SELECT id,action FROM worker_commands WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
        if row:
            db.execute("UPDATE worker_commands SET status='running',started_at=? WHERE id=? AND status='queued'",
                       (now(), row[0]))
        db.commit()
        return tuple(row) if row else None
    except Exception:
        db.rollback()
        raise


def complete(db: sqlite3.Connection, command_id: int, ok: bool, outcome: str = '', error: str = ''):
    db.execute('UPDATE worker_commands SET status=?,finished_at=?,outcome=?,error=? WHERE id=?',
               ('completed' if ok else 'failed', now(), str(outcome)[:1200], str(error)[:240], command_id))
    db.commit()


def heartbeat(db: sqlite3.Connection, *, action: str, error: str = '', event: str = '') -> None:
    moment = now()
    db.execute('INSERT OR IGNORE INTO worker_status(id,started_at,last_seen_at,updated_at) VALUES(1,?,?,?)',
               (moment, moment, moment))
    fields = ['last_seen_at=?', 'last_action=?', 'updated_at=?']
    values = [moment, action, moment]
    # Idle heartbeats must not erase real execution errors.
    if error or event:
        fields.append('last_error=?')
        values.append(error[:200])
    if action == 'started':
        fields.append('started_at=?')
        values.append(moment)
    if event == 'research':
        fields.append('last_research_at=?')
        values.append(moment)
    if event == 'monitor':
        fields.append('last_monitor_at=?')
        values.append(moment)
    db.execute('UPDATE worker_status SET '+','.join(fields)+' WHERE id=1', values)
    db.commit()
