#!/usr/bin/env python3
"""Read confirmed Jupiter CPI liquidation events; never signs transactions."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get('JLP_DATA_DIR', str(ROOT.parent / 'data')))
DATA_ROOT.mkdir(parents=True, exist_ok=True)
DB = DATA_ROOT / 'liquidations.sqlite3'
PROGRAM = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
AUTHORITY = '37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN'
POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq'
RPC = os.environ.get('JUPITER_MONITOR_RPC_URL', 'https://api.mainnet-beta.solana.com')
ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
MINTS = {'So11111111111111111111111111111111111111112': 'SOL',
         '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'BTC',
         '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH'}
IDL = json.loads((ROOT / 'jupiter-perps-idl.json').read_text())
SCHEMAS = {hashlib.sha256(('event:' + e['name']).encode()).digest()[:8]: e
           for e in IDL['events']}

def unbase58(text):
    n = 0
    for char in text:
        n = n * 58 + ALPHABET.index(char)
    return b'\0' * (len(text) - len(text.lstrip('1'))) + (n.to_bytes((n.bit_length()+7)//8, 'big') if n else b'')

def base58(data):
    n = int.from_bytes(data, 'big')
    text = ''
    while n:
        n, rem = divmod(n, 58)
        text = ALPHABET[rem] + text
    return '1' * (len(data) - len(data.lstrip(b'\0'))) + text

def decode(raw, schema):
    fields, offset = {}, 0
    for field in schema['fields']:
        typ = field['type']
        if isinstance(typ, dict):
            # Other event types are irrelevant to liquidation reporting.
            break
        size = {'publicKey':32, 'u8':1, 'bool':1, 'u64':8, 'i64':8, 'u128':16}[typ]
        part = raw[offset:offset+size]
        if len(part) != size:
            raise ValueError('Truncated ' + schema['name'])
        fields[field['name']] = base58(part) if typ == 'publicKey' else int.from_bytes(part, 'little', signed=typ=='i64')
        offset += size
    return fields

def liquidation_instructions(logs):
    stack, names = [], []
    for line in logs or []:
        match = re.match(r'Program (\w+) invoke \[\d+\]', line)
        if match:
            stack.append(match[1])
        elif re.match(r'Program \w+ (success|failed)', line):
            if stack:
                stack.pop()
        elif stack and stack[-1] == PROGRAM and line.startswith('Program log: Instruction: LiquidateFullPosition'):
            names.append(line.split(': ')[-1])
    return names

def extract(tx, signature):
    if not tx or not tx.get('meta') or tx['meta'].get('err') is not None:
        return []
    keys = tx['transaction']['message']['accountKeys']
    loaded = tx['meta'].get('loadedAddresses') or {}
    keys = keys + loaded.get('writable', []) + loaded.get('readonly', [])
    keys = [k['pubkey'] if isinstance(k, dict) else k for k in keys]
    rows = []
    for group in tx['meta'].get('innerInstructions') or []:
        for inner_index, ix in enumerate(group['instructions']):
            if keys[ix['programIdIndex']] != PROGRAM:
                continue
            raw = unbase58(ix.get('data', ''))
            # Anchor emit_cpi discriminator followed by the event discriminator.
            if raw[:8] != bytes.fromhex('e445a52e51cb9a1d'):
                continue
            schema = SCHEMAS.get(raw[8:16])
            if not schema or schema['name'] != 'LiquidateFullPositionEvent':
                continue
            try:
                data = decode(raw[16:], schema)
            except (ValueError, KeyError):
                rows.append(dict(eventId=f'{signature}:{group["index"]}:{inner_index}',
                    signature=signature,slot=tx['slot'],blockTime=tx.get('blockTime'),
                    observedAt=int(time.time()),decoded=False,
                    txUrl='https://solscan.io/tx/'+signature,
                    detail='Verified Jupiter liquidation event; its schema needs updating.'))
                continue
            if data['pool'] != POOL:
                continue
            rows.append(dict(eventId=f'{signature}:{group["index"]}:{inner_index}',
                signature=signature, slot=tx['slot'], blockTime=tx.get('blockTime'),
                observedAt=int(time.time()), market=MINTS.get(data['positionMint'], 'UNKNOWN'),
                side={1:'long',2:'short'}.get(data['positionSide'], 'unknown'),
                sizeUsd=data['positionSizeUsd']/1e6, priceUsd=data['price']/1e6,
                liquidationFeeUsd=data['liquidationFeeUsd']/1e6,
                feeUsd=data['feeUsd']/1e6, position=data['positionKey'], owner=data['owner'],
                txUrl='https://solscan.io/tx/'+signature, decoded=True, rawFields=data))
    names = liquidation_instructions(tx['meta'].get('logMessages'))
    if names and not rows:
        # A successful liquidation instruction is still reported if the IDL changes.
        rows.append(dict(eventId=signature+':undecoded',signature=signature,
            slot=tx['slot'],blockTime=tx.get('blockTime'),observedAt=int(time.time()),
            decoded=False,instructions=names,txUrl='https://solscan.io/tx/'+signature,
            detail='Successful Jupiter liquidation instruction; event fields could not be decoded.'))
    return rows

def rpc(method, params):
    request = json.dumps(dict(jsonrpc='2.0', id=1, method=method, params=params))
    last_error = 'RPC failed'
    for attempt in range(3):
        result = subprocess.run(['/usr/bin/curl','--silent','--show-error','--max-time','18',
            '--write-out','\n%{http_code}',RPC,'-H','Content-Type: application/json',
            '--data-binary',request],capture_output=True,text=True,timeout=22)
        try:
            body, status = result.stdout.rsplit('\n',1)
            if result.returncode or status != '200':
                raise RuntimeError('RPC HTTP '+status)
            parsed = json.loads(body)
            if 'error' in parsed:
                raise RuntimeError('RPC error '+str(parsed['error'].get('code')))
            return parsed['result']
        except (ValueError, KeyError, RuntimeError) as error:
            last_error = str(error)
            if attempt < 2:
                time.sleep(2 ** (attempt+1))
    raise RuntimeError(last_error)

class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()

def connect():
    db = sqlite3.connect(DB, timeout=10, factory=ClosingConnection)
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,body TEXT,reported_at INTEGER);''')
    return db

def state(db, key):
    row = db.execute('SELECT value FROM state WHERE key=?',(key,)).fetchone()
    return row[0] if row else None

def save_state(db, key, value):
    db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',(key,str(value)))

@contextmanager
def poll_guard():
    with (DATA_ROOT / 'liquidations-poll.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another collector is currently polling')
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)

def poll(db, max_transactions=40):
    cursor = state(db,'cursor')
    if not cursor:
        recent = rpc('getSignaturesForAddress',[AUTHORITY,dict(limit=1,commitment='finalized')])
        if not recent:
            raise RuntimeError('No baseline signature returned')
        save_state(db,'cursor',recent[0]['signature'])
        save_state(db,'started_at',int(time.time()))
        save_state(db,'coverage_since',recent[0].get('blockTime') or int(time.time()))
        save_state(db,'checkpoint_time',recent[0].get('blockTime') or int(time.time()))
        save_state(db,'backlog',0)
        save_state(db,'last_success',int(time.time()))
        db.commit()
        return dict(initialized=True, baselineSlot=recent[0]['slot'], checkedTransactions=0)
    signatures, before, reached = [], None, False
    for _ in range(300):
        config = dict(limit=100,commitment='finalized')
        if before:
            config['before'] = before
        page = rpc('getSignaturesForAddress',[AUTHORITY,config])
        for info in page:
            if info['signature'] == cursor:
                reached = True
                break
            signatures.append(info)
        if reached:
            break
        if not page:
            raise RuntimeError('Checkpoint not found in RPC history; coverage gap requires repair')
        before = page[-1]['signature']
    if not reached:
        raise RuntimeError('Catch-up pagination cap reached; checkpoint was not advanced')
    checked, found = 0, 0
    for info in list(reversed(signatures))[:max_transactions]:
        if info['err'] is None:
            tx = rpc('getTransaction',[info['signature'],dict(encoding='json',commitment='finalized',maxSupportedTransactionVersion=0)])
            if not tx:
                raise RuntimeError('Transaction unavailable; checkpoint retained for retry')
            for event in extract(tx,info['signature']):
                inserted=db.execute('INSERT OR IGNORE INTO events VALUES(?,?,NULL)',
                    (event['eventId'],json.dumps(event))).rowcount
                found += inserted
        save_state(db,'cursor',info['signature'])
        if info.get('blockTime'):
            save_state(db,'checkpoint_time',info['blockTime'])
        db.commit()
        checked += 1
        time.sleep(0.35)
    save_state(db,'last_success',int(time.time()))
    save_state(db,'last_error','')
    save_state(db,'backlog',max(0,len(signatures)-checked))
    db.commit()
    return dict(initialized=False,checkedTransactions=checked,newEvents=found,
                catchupRemaining=max(0,len(signatures)-checked))

def snapshot(db, now=None):
    now=int(time.time()) if now is None else now
    since=int(state(db,'coverage_since') or state(db,'started_at') or 0)
    last=int(state(db,'last_success') or 0)
    events=[json.loads(r[0]) for r in db.execute('SELECT body FROM events ORDER BY rowid DESC')]
    relevant=[e for e in events if (e.get('blockTime') or e['observedAt']) >= now-86400]
    totals=dict(count=len(relevant),longCount=0,shortCount=0,longUsd=0,shortUsd=0,
                notionalUsd=0,liquidationFeeUsd=0,undecodedCount=0)
    for event in relevant:
        if not event.get('decoded'):
            totals['undecodedCount']+=1
            continue
        if event['side'] in ['long','short']:
            totals[event['side']+'Count']+=1
            totals[event['side']+'Usd']+=event['sizeUsd']
        totals['notionalUsd']+=event['sizeUsd']
        totals['liquidationFeeUsd']+=event['liquidationFeeUsd']
    buckets={}
    # Each point is cumulative observed notional, never a backfill of missing history.
    for event in sorted(events,key=lambda e:((e.get('blockTime') or e['observedAt']),e['eventId'])):
        timestamp=event.get('blockTime') or event['observedAt']
        if timestamp < max(since,now-86400) or not event.get('decoded'):
            continue
        bucket=timestamp//60*60
        point=buckets.setdefault(bucket,dict(long=0,short=0))
        if event['side'] in point:
            point[event['side']]+=event['sizeUsd']
    error=state(db,'last_error') or None
    backlog=int(state(db,'backlog') or 0)
    return dict(fetchedAt=last*1000,error=error,coverageSince=since*1000,
        checkpointAt=int(state(db,'checkpoint_time') or 0)*1000,
        backlog=backlog,connected=bool(last and now-last<120 and not error),
        partial24h=bool(not since or since>now-86400 or error or backlog or totals['undecodedCount']),
        commitment='finalized',source='Jupiter Perps program · Solana RPC',
        totals=totals,events=[{k:v for k,v in e.items() if k not in ['rawFields','owner']} for e in events[:200]],eventCount=len(events),
        minuteBuckets=[[t*1000,v['long'],v['short']] for t,v in sorted(buckets.items())])

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--poll',action='store_true')
    parser.add_argument('--pending',action='store_true')
    parser.add_argument('--ack',nargs='+')
    parser.add_argument('--audit',type=int,default=0)
    args=parser.parse_args()
    with connect() as db:
        output={}
        if args.poll:
            try:
                with poll_guard():
                    output['poll']=poll(db)
            except Exception as error:
                if 'Another collector' in str(error):
                    output['poll']=dict(busy=True)
                else:
                    save_state(db,'last_error',str(error));db.commit()
                    output['error']=str(error)
        if args.audit:
            recent=rpc('getSignaturesForAddress',[AUTHORITY,dict(limit=min(args.audit,1000),commitment='finalized')])
            events=[]
            for info in recent:
                if info['err'] is None:
                    tx=rpc('getTransaction',[info['signature'],dict(encoding='json',commitment='finalized',maxSupportedTransactionVersion=0)])
                    if tx: events.extend(extract(tx,info['signature']))
                    time.sleep(0.35)
            output['audit']=dict(transactions=len(recent),events=events)
        if args.ack:
            for event_id in args.ack:
                db.execute('UPDATE events SET reported_at=? WHERE event_id=? AND reported_at IS NULL',(int(time.time()),event_id))
            db.commit()
            output['acknowledged']=len(args.ack)
        output['pending']=[json.loads(row[0]) for row in db.execute('SELECT body FROM events WHERE reported_at IS NULL ORDER BY rowid')]
        output['health']={key:state(db,key) for key in ['started_at','last_success','last_error']}
        print(json.dumps(output))

if __name__=='__main__':
    main()
