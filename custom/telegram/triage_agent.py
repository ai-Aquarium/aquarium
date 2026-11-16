#!/usr/bin/env python3
"""
Telegram Triage Agent (FG-03 P6)

Watches the gateway's Telegram batch files (``hermes_cli.telegram_triage``)
and triages each one with the source owner's user-profile agents: one router
call picks the profiles (P4), each picked profile's agent triages it and its
result is acted on in that profile, as the owner (P5).

Telegram has no legacy triage. With ``triage.agent.telegram: off`` (the
default) batch files are left untouched. A batch with no routing decision yet
stays for the next pass; one that still cannot be triaged after
``profile_triage.MAX_AGENT_ATTEMPTS`` passes is stored as processed and the
owner gets one in-app notification.
"""

import glob
import json
import os
import sqlite3
import sys
import time

from hermes_cli import telegram_triage
from hermes_cli.config import load_config as load_hermes_config

# Shared modules (triage_handlers, profile_triage)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.profile_triage import triage_routed

BATCH_DIR = str(telegram_triage.BATCH_DIR)
PROCESSED_DIR = str(telegram_triage.PROCESSED_DIR)
POLL_SECONDS = 3


def log(line):
    print(f"[telegram-triage] {line}", flush=True)


def get_db():
    """No box-wide Telegram channel tables: results act only in profiles."""
    return sqlite3.connect(":memory:")


def process_batch_file(batch_path, config=None):
    """Triage one batch file. Returns True when it ran (router/agents)."""
    config = load_hermes_config() if config is None else config
    if telegram_triage.mode(config) != "agent":
        return False
    with open(batch_path) as f:
        batch = json.load(f)
    log(f"Processing batch {batch.get('batch_id')}: chat {batch.get('chat_id')} on "
        f"{batch.get('account_id')} ({len(batch.get('messages') or [])} msgs)")
    os.makedirs(PROCESSED_DIR, exist_ok=True)
    triage_routed('telegram', batch, batch_path,
                  legacy_triage=None, legacy_act=None,
                  get_db=get_db, processed_dir=PROCESSED_DIR,
                  config=config, log=log)
    return True


def _arrival_time(path):
    try:
        with open(path) as f:
            return str(json.load(f).get('created_at') or '')
    except (OSError, ValueError):
        return ''


def run_pass(config=None):
    """One scan of ``BATCH_DIR``; returns how many batches were processed."""
    config = load_hermes_config() if config is None else config
    if telegram_triage.mode(config) != "agent":
        return 0
    ran = 0
    batch_files = glob.glob(os.path.join(BATCH_DIR, '*.json'))
    for bf in sorted(batch_files, key=lambda path: (_arrival_time(path), path)):
        try:
            if process_batch_file(bf, config):
                ran += 1
        except Exception as e:
            log(f"Error processing {bf}: {e!r}")
    return ran


def main():
    log(f"Starting Telegram triage agent; watching {BATCH_DIR}")
    while True:
        try:
            ran = run_pass()
        except Exception as e:
            log(f"Pass failed: {e!r}")
            ran = 0
        time.sleep(1 if ran else POLL_SECONDS)


if __name__ == '__main__':
    main()
