"""Restore an authenticated dashboard CSV export without inventing observations.

Usage: python3 import_history.py export.csv destination.sqlite3
The destination must already have the samples schema. Back it up first.
"""
import csv
from datetime import datetime
import math
import sqlite3
import sys

def restore(csv_path, db_path):
    rows=[]
    with open(csv_path, newline='') as source:
        reader=csv.DictReader(source)
        if reader.fieldnames != ['metric','timestamp_utc','value','source']:
            raise ValueError('Not a JLP history export')
        for row in reader:
            if row['metric']=='neutral_carry_apr':
                continue  # Reconstructed from original components at query time.
            timestamp=datetime.fromisoformat(row['timestamp_utc'])
            if timestamp.tzinfo is None:
                raise ValueError('Timestamp must include its time zone')
            value=float(row['value'])
            if not math.isfinite(value):
                raise ValueError('Non-finite observation')
            rows.append((row['metric'],round(timestamp.timestamp()*1000),value,row['source']))
    with sqlite3.connect(db_path) as db:
        db.executemany('INSERT OR REPLACE INTO samples(metric,ts,value,source) VALUES(?,?,?,?)',rows)
    return len(rows)

if __name__=='__main__':
    print(f'Restored {restore(*sys.argv[1:])} observed samples')
