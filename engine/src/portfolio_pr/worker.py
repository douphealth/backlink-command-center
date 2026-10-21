"""Persistent single-worker coordinator with a durable dashboard command queue.

Runs only when a real VPS/container hosts it. Operator controls can pause research,
outbound mail, and paid DataForSEO without restarting the worker. Starting or
completing a queued command never means a link was actually acquired.
"""
from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import signal
import sqlite3
import sys
import time
from .cli import main
from . import opstate

SHUTDOWN = False


def _shutdown(*_):
    global SHUTDOWN
    SHUTDOWN = True


def _dbpath():
    return Path(os.getenv('PR_DB_PATH', 'state/outreach.sqlite3'))


def _connect():
    path = _dbpath()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=12)
    db.execute('PRAGMA busy_timeout=12000')
    opstate.ensure(db)
    return db


def _args(command: str) -> list[str]:
    return ['--db', str(_dbpath()), '--config', os.getenv('PR_CONFIG', 'config/sites.json'), command]


def run_once():
    with _connect() as db:
        if opstate.flag(db, 'research_paused'):
            return {'status': 'paused', 'reason': 'Operator paused research', 'code': None}
        send = (os.getenv('PR_SEND_ENABLED', '').upper() == 'YES'
                and not opstate.flag(db, 'outreach_paused'))
    args = _args('run') + ['--max-calls', os.getenv('MAX_SEARCHES_PER_RUN', '3')]
    if send:
        args.append('--send-live')
    code = main(args)
    status = 'completed' if code == 0 else 'failed'
    if code == 0:
        with _connect() as db:
            row = db.execute("SELECT detail FROM activity WHERE type='run_finished' ORDER BY id DESC LIMIT 1").fetchone()
            if row:
                try:
                    run_out = json.loads(row[0]); status = ('completed' if run_out.get('run_status') == 'work_done' else 'no_meaningful_work')
                except (TypeError,ValueError):
                    status = 'needs_log_reconciliation'
            else:
                status = 'needs_log_reconciliation'
    return {'status':status,'code':code,'send_enabled':send}



def check_replies_once():
    code = main(_args('monitor-replies') + ['--limit', os.getenv('MAX_THREAD_CHECKS_PER_HOUR', '30')])
    return {'status': 'completed' if code == 0 else 'failed', 'code': code}


def execute_command(action: str):
    if action == 'research':
        return run_once()
    mapping = {
        'verify': ('verify', ['--limit', '10']),
        'audit_assets': ('audit-sites', ['--max-checks', '10']),
        'check_links': ('check-links', ['--limit', '15']),
        'monitor': ('monitor-replies', ['--limit', '30']),
        'weekly': ('weekly-check', ['--limit', '30']),
    }
    if action not in mapping:
        raise ValueError('Unsupported command')
    command, extra = mapping[action]
    code = main(_args(command) + extra)
    return {'status': 'completed' if code == 0 else 'failed', 'code': code}


def note(action: str, error: str = '', event: str = ''):
    try:
        with _connect() as db:
            opstate.heartbeat(db, action=action, error=error, event=event)
    except (sqlite3.Error, OSError) as exc:
        print(json.dumps({'event':'heartbeat_failed','kind':type(exc).__name__}),file=sys.stderr,flush=True)


def execute_queued():
    with _connect() as db:
        claimed = opstate.claim(db)
    if not claimed:
        return False
    job_id, action = claimed
    note('command:'+action)
    try:
        result = execute_command(action)
        success = result.get('status') == 'completed' and result.get('code') == 0
        with _connect() as db:
            opstate.complete(db, job_id, success, json.dumps(result), '' if success else result.get('reason','Command did not complete'))
        note('command_finished:'+action, error='' if success else result.get('reason','Worker command failed'))
    except Exception as exc:
        with _connect() as db:
            opstate.complete(db, job_id, False, '', type(exc).__name__)
        note('command_failed:'+action, error=type(exc).__name__)
    return True


def run_forever(interval_seconds: int = 14400, monitor_interval_seconds: int = 3600):
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    lock_file = Path(os.getenv('PR_WORKER_LOCK', 'state/worker.lock'))
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_file, 'w') as lock:
        try:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (ImportError, BlockingIOError):
            print(json.dumps({'status':'blocked','reason':'worker already active or file locking unsupported'}),file=sys.stderr)
            return 2
        note('started')
        print(json.dumps({'status':'worker_started','at':opstate.now(),'research_interval_seconds':interval_seconds,
                          'monitor_interval_seconds':monitor_interval_seconds,'outbound_default_paused':True}),flush=True)
        next_research = time.monotonic()
        next_watch = time.monotonic()
        next_heartbeat = time.monotonic()
        while not SHUTDOWN:
            now = time.monotonic()
            if now >= next_heartbeat:
                note('idle')
                next_heartbeat = now + 12
            if execute_queued():
                continue
            if now >= next_research:
                try:
                    result = run_once()
                    error = '' if result['status'] in ('completed','paused') else 'Research completed without verifiable action or failed'
                    note('research_'+result['status'],error=error,event='research' if result['status']=='completed' else '')
                    print(json.dumps({'event':'research_run_finished','at':opstate.now(),**result}),flush=True)
                except Exception as exc:
                    note('research_crashed',error=type(exc).__name__)
                    print(json.dumps({'event':'research_run_crashed','error':type(exc).__name__}),file=sys.stderr,flush=True)
                next_research = time.monotonic()+interval_seconds
            if SHUTDOWN:break
            now = time.monotonic()
            if now >= next_watch:
                try:
                    result = check_replies_once()
                    note('reply_watch_'+result['status'],event='monitor' if result['code']==0 else '')
                    print(json.dumps({'event':'reply_watch_finished','at':opstate.now(),**result}),flush=True)
                except Exception as exc:
                    note('reply_watch_crashed',error=type(exc).__name__)
                    print(json.dumps({'event':'reply_watch_crashed','error':type(exc).__name__}),file=sys.stderr,flush=True)
                next_watch = time.monotonic()+monitor_interval_seconds
            if not SHUTDOWN:
                # Polling is cheap local SQLite activity; it never calls paid APIs.
                time.sleep(max(.2,min(8.0,next_research-time.monotonic(),next_watch-time.monotonic())))
        note('stopped')
    return 0


if __name__ == '__main__':
    interval=int(os.getenv('PR_RUN_INTERVAL_SECONDS','14400'))
    monitoring=int(os.getenv('PR_MONITOR_INTERVAL_SECONDS','3600'))
    raise SystemExit(run_forever(max(3600,interval),max(3600,monitoring)))
