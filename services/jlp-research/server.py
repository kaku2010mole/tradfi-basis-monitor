#!/usr/bin/env python3
"""Read-only JLP research data service; Python standard library only."""
import concurrent.futures
import csv
import io
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import threading
import time
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from monitoring import jupiter_liquidations as liquidation_feed

ROOT = Path(__file__).resolve().parent
SEED_DB = ROOT / 'data' / 'research.sqlite3'
DB = Path(os.environ.get('JLP_DATA_DIR', str(ROOT / 'data'))) / 'research.sqlite3'
DB.parent.mkdir(exist_ok=True)
if DB != SEED_DB and not DB.exists() and SEED_DB.exists():
    shutil.copy2(SEED_DB, DB)
JLP = '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4'
PERPS = 'https://perps-api.jup.ag/v1/'
HL = 'https://api.hyperliquid.xyz/info'
LOCK = threading.RLock()
STATE = {}
PENDING = {}
LIVE_SOURCES = {'pool','loan','price','funding','strategy','activity'}
MARKETS={'BTC':'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
         'ETH':'7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
         'SOL':'So11111111111111111111111111111111111111112'}
RECORD_INTERVAL_MS = 60000
STOP = threading.Event()

def connect():
    c = sqlite3.connect(DB, timeout=20)
    c.execute('PRAGMA journal_mode=WAL')
    return c

with connect() as c:
    c.executescript('''
    CREATE TABLE IF NOT EXISTS samples(metric TEXT, ts INTEGER, value REAL, source TEXT, PRIMARY KEY(metric, ts, source));
    CREATE INDEX IF NOT EXISTS samples_time ON samples(metric, ts);
    CREATE TABLE IF NOT EXISTS cache(name TEXT PRIMARY KEY, body TEXT);
    ''')
    for name, body in c.execute('SELECT name, body FROM cache'):
        STATE[name] = json.loads(body)

def fetch(url, body=None):
    # curl uses the OS TLS certificate store and works with this host's network.
    args = ['/usr/bin/curl', '--fail-with-body', '--silent', '--show-error', '--location', '--max-time', '18', '--retry', '1', url]
    if body is not None:
        args += ['-H', 'Content-Type: application/json', '--data-binary', json.dumps(body)]
    p = subprocess.run(args, capture_output=True, text=True, timeout=42)
    if p.returncode:
        raise RuntimeError(f'Upstream request failed ({p.returncode}): {p.stderr[:160]}')
    return json.loads(p.stdout)

def number(v, positive=False):
    n = float(v)
    if not math.isfinite(n) or (positive and n <= 0):
        raise ValueError('Invalid upstream number')
    return n

def store(name, body, rows=()):
    # Live updates stay in memory. Only the latest batch per source is retained.
    with LOCK:
        STATE[name] = body
        PENDING[name] = tuple(rows)

def persist():
    """One transaction per minute, with at most one live point per minute.

    The bucket represents a recorded snapshot, not an average. Strategy's four
    components always share the same timestamp. UPSERT also prevents duplicate
    minute samples after a service restart.
    """
    now=int(time.time()*1000)
    bucket=now//RECORD_INTERVAL_MS*RECORD_INTERVAL_MS
    with LOCK, connect() as c:
        c.executemany('INSERT OR REPLACE INTO cache VALUES (?,?)',
                      [(name,json.dumps(body)) for name,body in STATE.items()])
        for name,rows in PENDING.items():
            if name in LIVE_SOURCES:
                body=STATE.get(name,{})
                if body.get('error') or not 0<=now-body.get('fetchedAt',0)<45000:
                    continue
                rows=[(k,bucket,v,s) for k,t,v,s in rows]
            c.executemany('INSERT OR REPLACE INTO samples VALUES (?,?,?,?)',rows)
        c.commit()
        PENDING.clear()

def fail(name, error):
    with LOCK:
        prior = dict(STATE.get(name, {}))
    prior.update(error=str(error), attemptedAt=int(time.time()*1000))
    store(name, prior)

def derive_hedges(d):
    """First-order NAV delta with custody balances / trader positions held fixed.

    A_i = G_i + (owned_i-locked_i)*P_i + S_i*(P_i/Pavg_i-1).
    Hence dA_i/dP_i = owned_i-locked_i + S_i/Pavg_i,
    and P_i*dA_i/dP_i = A_i-G_i+S_i. Raw USD fields have 6 decimals.
    """
    aum=number(d['aumUsd'],True)/1e6
    supply=number(d['jlpTotalSupply'],True)/1e6
    result={}
    for c in d['custodies']:
        symbol={'WBTC':'BTC','ETH':'ETH','SOL':'SOL'}.get(c['symbol'])
        if not symbol: continue
        decimals=9 if symbol=='SOL' else 8
        net_tokens=(number(c['owned'])-number(c['locked']))/10**decimals
        short_size=number(c['globalShortSizes'])/1e6
        if short_size<0: raise ValueError('Invalid short size')
        short_delta=short_size/number(c['globalShortAveragePrice'],True)*1e6 if short_size else 0
        delta_tokens=net_tokens+short_delta
        delta_usd=(number(c['aumUsd'])-number(c['guaranteedUsd'])+number(c['globalShortSizes']))/1e6
        result[symbol]=dict(ratio=delta_usd/aum*100,unitsPerJlp=delta_tokens/supply,
                            spotWeight=number(c['currentWeightagePct']),deltaUsd=delta_usd,
                            ownedTokens=number(c['owned'])/10**decimals,
                            lockedTokens=number(c['locked'])/10**decimals,
                            shortUsd=short_size,shortDeltaTokens=short_delta,
                            guaranteedUsd=number(c['guaranteedUsd'])/1e6,
                            supply=supply)
    if len(result)!=3: raise ValueError('Incomplete custody data for hedge calculation')
    return result

def neutral_carry(p,q,l,f,now):
    for label,d in [('pool',p),('price',q),('loan',l),('funding',f)]:
        if d.get('error') or not d.get('fetchedAt') or not 0<=now-d['fetchedAt']<45000:
            raise ValueError(f'{label} data is unavailable or stale')
    if not q.get('sourceAt') or not 0<=now-q['sourceAt']<120000:
        raise ValueError('Market price timestamp is unavailable or stale')
    if p.get('hedgesError') or len(p.get('hedges',{}))!=3:
        raise ValueError('Hedge calculation is unavailable')
    market=number(q['price'],True)
    # JLP fee APR is measured on NAV; translate it to the cost of market JLP.
    fee_apr=number(p['apr'])*number(p['nav'],True)/market
    funding_apr=0;margin_notional=0;positions={}
    for coin in ['BTC','ETH','SOL']:
        hedge=p['hedges'][coin]; ctx=f['coins'][coin]
        oracle=number(ctx['oracle'],True)
        ratio=number(hedge['unitsPerJlp'])*oracle/market
        contribution=ratio*number(ctx['annual'])
        funding_apr+=contribution
        mark=number(ctx['mark'],True)
        margin_ratio=abs(number(hedge['unitsPerJlp']))*mark/market
        margin_notional+=margin_ratio
        positions[coin]=dict(hedgeRatioMarket=ratio*100,fundingContribution=contribution,
                             unitsPerJlp=hedge['unitsPerJlp'],oracle=oracle,mark=mark,marginRatio=margin_ratio)
    return dict(fetchedAt=now,feeAprPer1x=fee_apr,fundingAprPer1x=funding_apr,
                borrowApr=number(l['apr']),nav=number(p['nav'],True),market=market,
                marginNotionalPer1x=margin_notional,positions=positions,maxLtv=l['maxLtv'],error=None,
                inputTimes={k:d['fetchedAt'] for k,d in [('pool',p),('price',q),('loan',l),('funding',f)]})

def leveraged_apr(fee,funding,borrow,leverage):
    leverage=number(leverage)
    if not 1<=leverage<=10: raise ValueError('Leverage must be between 1 and 10')
    return leverage*(number(fee)+number(funding))-(leverage-1)*number(borrow)

def total_capital_carry(fee,funding,borrow,margin_notional,leverage,hedge_leverage):
    hedge_leverage=number(hedge_leverage)
    if not 1<=hedge_leverage<=40: raise ValueError('Hedge leverage must be between 1 and 40')
    margin_notional=number(margin_notional)
    if margin_notional<0: raise ValueError('Invalid margin notional')
    factor=1+number(leverage)*margin_notional/hedge_leverage
    return dict(apr=leveraged_apr(fee,funding,borrow,leverage)/factor,capitalFactor=factor)

def strategy():
    with LOCK: p,q,l,f=[dict(STATE.get(k,{})) for k in ['pool','price','loan','funding']]
    now=int(time.time()*1000)
    out=neutral_carry(p,q,l,f,now)
    store('strategy',out,[(k,now,out[v],'Point-in-time theoretical carry') for k,v in
          [('carry_fee_1x','feeAprPer1x'),('carry_funding_1x','fundingAprPer1x'),('carry_borrow_apr','borrowApr'),('carry_margin_notional_1x','marginNotionalPer1x')]])

def pool():
    d = fetch(PERPS+'jlp-info')
    ts = int(time.time()*1000)
    out = dict(fetchedAt=ts, nav=number(d['jlpPriceUsd'], True)/1e6,
               apr=number(d['jlpAprPct']), apy=number(d['jlpApyPct']),
               yieldUpdatedAt=int(d['jlpAprLastUpdatedTimestamp'])*1000,
               aum=number(d['aumUsd'])/1e6,
               weights=[dict(symbol=x['symbol'],weight=number(x['currentWeightagePct'])) for x in d['custodies']], error=None)
    rows=[(k,ts,out[v],'Jupiter official') for k,v in [('nav','nav'),('jlp_apr','apr'),('jlp_apy','apy')]]
    try:
        out['hedges']=derive_hedges(d);out['hedgesError']=None
        for coin,h in out['hedges'].items():
            rows.extend([(f'hedge_ratio_{coin}',ts,h['ratio'],'Jupiter first-order custody delta'),
                         (f'hedge_units_{coin}',ts,h['unitsPerJlp'],'Jupiter first-order custody delta')])
            for field in ['ownedTokens','lockedTokens','shortUsd','shortDeltaTokens','guaranteedUsd','supply']:
                rows.append((f'custody_{field}_{coin}',ts,h[field],'Jupiter custody state'))
    except Exception as e:
        out['hedges']={};out['hedgesError']=str(e)
    store('pool', out, rows)

def derive_activity(hedges, markets):
    coins={}
    for coin in MARKETS:
        h=hedges[coin];m=markets[coin]
        px=number(m['price'],True);volume=number(m['volume'])
        long=number(h['lockedTokens'])*px;short=number(h['shortUsd'])
        if min(volume,long,short)<0: raise ValueError('Invalid activity values')
        coins[coin]=dict(price=px,volume24h=volume,longOi=long,shortOi=short,
                         grossOi=long+short,longShare=long/(long+short)*100 if long+short else None)
    totals={field:sum(c[field] for c in coins.values()) for field in ['volume24h','longOi','shortOi','grossOi']}
    totals['oneSidedOi']=totals['grossOi']/2
    totals['longShare']=totals['longOi']/totals['grossOi']*100 if totals['grossOi'] else None
    return dict(coins=coins,totals=totals)

def activity():
    # Join current official market quotes to fresh custody state. Volume is a
    # trailing-24h counter, not incremental volume; snapshots must not be summed.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        jobs={coin:executor.submit(fetch,PERPS+'market-stats?mint='+mint) for coin,mint in MARKETS.items()}
        markets={coin:job.result() for coin,job in jobs.items()}
    now=int(time.time()*1000)
    with LOCK: p=dict(STATE.get('pool',{}))
    if p.get('error') or p.get('hedgesError') or not 0<=now-p.get('fetchedAt',0)<45000:
        raise ValueError('Fresh custody state is required for OI')
    out=derive_activity(p['hedges'],markets)
    out.update(fetchedAt=now,custodyAt=p['fetchedAt'],error=None,
               custodySnapshot=p['hedges'],
               liquidationCoverage='separate_chain_feed',
               oiMethod='Long: locked token quantity × current Jupiter quote; short: globalShortSizes. Gross = long + short; one-sided reference = gross / 2.')
    rows=[]
    for coin,c in out['coins'].items():
        for field in ['volume24h','longOi','shortOi','grossOi']:
            rows.append((f'perps_{field}_{coin}',now,c[field],'Jupiter official; long OI mark-valued approximation'))
    for field,value in out['totals'].items():
        if value is not None:rows.append((f'perps_{field}_TOTAL',now,value,'Jupiter official; local gross / one-sided definitions'))
    store('activity',out,rows)

def liquidations():
    with liquidation_feed.connect() as db:
        try:
            with liquidation_feed.poll_guard():
                liquidation_feed.poll_with_backoff(db)
        except Exception as error:
            if 'Another collector' not in str(error):
                liquidation_feed.save_state(db,'last_error',str(error))
                db.commit()
        snapshot=liquidation_feed.snapshot(db)
    store('liquidations',snapshot)

def loan():
    d = fetch(PERPS+'lending/info'); ts = int(time.time()*1000)
    out = dict(fetchedAt=ts, apr=number(d['borrowApr']), utilization=number(d['utilizationRatePercentage']),
               available=number(d['availableLiquidityUsd'])/1e6, maxLtv=number(d['maxLtvPercentage']), error=None)
    store('loan',out,[('borrow_apr',ts,out['apr'],'Jupiter JLP Loan')])

def price():
    d = fetch('https://api.jup.ag/price/v3?ids='+JLP)[JLP]
    ts = int(time.time()*1000); slot = int(d['blockId'])
    with LOCK: old = STATE.get('price',{})
    source_ts = old.get('sourceAt') if old.get('slot')==slot else None
    if source_ts is None:
        try:
            t = fetch('https://api.mainnet-beta.solana.com',{'jsonrpc':'2.0','id':1,'method':'getBlockTime','params':[slot]}).get('result')
            source_ts = int(t)*1000 if t is not None else None
        except Exception:
            pass
    out = dict(fetchedAt=ts,price=number(d['usdPrice'],True),slot=slot,sourceAt=source_ts,
               change24h=number(d.get('priceChange24h',0)),error=None)
    rows = [('market_price',ts,out['price'],'Jupiter Price v3')]
    with LOCK: p = STATE.get('pool',{})
    # Never compute a live premium by pairing a stale reference with a fresh one.
    if source_ts and abs(ts-source_ts)<120000 and p.get('nav') and ts-p.get('fetchedAt',0)<45000 and not p.get('error'):
        out['premium']=(out['price']/p['nav']-1)*100
        out['navPairedAt']=p['fetchedAt']
        out['pairedNav']=p['nav']
        rows.append(('premium',ts,out['premium'],'Jupiter price / pool NAV'))
    store('price',out,rows)

def funding():
    d = fetch(HL,{'type':'metaAndAssetCtxs'}); ts = int(time.time()*1000)
    coins={a['name']:dict(hourly=number(b['funding'])*100,annual=number(b['funding'])*8760*100,mark=number(b['markPx']),oracle=number(b['oraclePx'],True))
           for a,b in zip(d[0]['universe'],d[1]) if a['name'] in ['BTC','ETH','SOL']}
    if len(coins)!=3: raise ValueError('Incomplete funding response')
    store('funding',dict(fetchedAt=ts,coins=coins,error=None),[(f'funding_live_{coin}',ts,x['hourly'],'Hyperliquid current') for coin,x in coins.items()])

def history():
    # Research archive, intentionally a separate series from the official weekly rate.
    try:
        d = fetch('https://openjup.com/api/apr-history?window=7d&range=90d')
        now = int(time.time()*1000); rows=[]
        for x in d['points']:
            end=int(datetime.fromisoformat(x['windowEnd']).timestamp()*1000)
            if end>now: continue  # exclude the still-incomplete UTC daily bucket
            ts=int(datetime.fromisoformat(x['timestamp']).timestamp()*1000)
            rows.append(('jlp_apr_archive',ts,number(x['windowApr']),'OpenJUP 7-day fee APR'))
        store('jlpHistory',dict(fetchedAt=now,count=len(rows),meta=d.get('meta'),error=None),rows)
    except Exception as e: fail('jlpHistory',e)
    end=int(time.time()*1000)
    for coin in ['BTC','ETH','SOL']:
        name='history_'+coin
        try:
            with connect() as c:
                last=c.execute('SELECT MAX(ts) FROM samples WHERE metric=?',(f'funding_{coin}',)).fetchone()[0]
            cursor=max(end-90*86400000,(last+1) if last else 0)
            count=0
            while cursor<end:
                # Explicit weekly chunks avoid the upstream 500-row response cap.
                finish=min(cursor+7*86400000,end)
                d=fetch(HL,dict(type='fundingHistory',coin=coin,startTime=cursor,endTime=finish))
                if not isinstance(d,list): raise ValueError('Invalid funding history')
                rows=[(f'funding_{coin}',int(x['time']),number(x['fundingRate'])*100,'Hyperliquid settled') for x in d]
                with connect() as c: c.executemany('INSERT OR REPLACE INTO samples VALUES (?,?,?,?)',rows)
                count+=len(rows);cursor=finish+1
                time.sleep(.2)
            store(name,dict(fetchedAt=int(time.time()*1000),added=count,error=None))
        except Exception as e: fail(name,e)

def loop(name, fn, interval):
    while not STOP.is_set():
        start=time.monotonic()
        try: fn()
        except Exception as e:
            print(name, str(e), flush=True);fail(name,e)
        STOP.wait(max(1,interval-(time.monotonic()-start)))

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw): super().__init__(*a,directory=str(ROOT/'public'),**kw)
    def log_message(self,*args): pass
    def send(self,body,ctype='application/json; charset=utf-8'):
        raw=body.encode();self.send_response(200);self.send_header('Content-Type',ctype)
        self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        p=urlparse(self.path)
        if p.path=='/api/state':
            with LOCK: d=dict(STATE)
            d['now']=int(time.time()*1000)
            with connect() as c: d['collectionStartedAt']=c.execute("SELECT MIN(ts) FROM samples WHERE metric='borrow_apr'").fetchone()[0]
            return self.send(json.dumps(d,allow_nan=False))
        if p.path=='/api/liquidations.csv':
            with liquidation_feed.connect() as c:
                events=[json.loads(row[0]) for row in c.execute('SELECT body FROM events ORDER BY rowid')]
            buf=io.StringIO();writer=csv.writer(buf)
            writer.writerow(['event_id','timestamp_utc','market','side','position_size_usd','price_usd','liquidation_fee_usd','decoded','transaction_url'])
            for event in events:
                t=event.get('blockTime')
                writer.writerow([event['eventId'],datetime.fromtimestamp(t,__import__('datetime').timezone.utc).isoformat() if t else '',event.get('market',''),event.get('side',''),event.get('sizeUsd',''),event.get('priceUsd',''),event.get('liquidationFeeUsd',''),event['decoded'],event['txUrl']])
            return self.send(buf.getvalue(),'text/csv; charset=utf-8')
        if p.path in ['/api/history','/api/export.csv']:
            try:
                args=parse_qs(p.query)
                days=number(args.get('days',['7'])[0]);days=max(1/1440,min(90,days))
                leverage=number(args.get('leverage',['2'])[0])
                hedge_leverage=number(args.get('hedgeLeverage',['10'])[0])
                leveraged_apr(0,0,0,leverage)
                total_capital_carry(0,0,0,0,leverage,hedge_leverage)
            except ValueError: self.send_error(400);return
            start=int(time.time()*1000-days*86400000)
            with connect() as c:
                rows=c.execute('SELECT metric,ts,value,source FROM samples WHERE ts>=? ORDER BY ts',(start,)).fetchall()
            snapshots={}
            components={'carry_fee_1x','carry_funding_1x','carry_borrow_apr','carry_margin_notional_1x'}
            for k,t,v,s in rows:
                if k in components:snapshots.setdefault(t,{})[k]=v
            for ts,x in snapshots.items():
                if len(x)==4:
                    apr=total_capital_carry(x['carry_fee_1x'],x['carry_funding_1x'],x['carry_borrow_apr'],x['carry_margin_notional_1x'],leverage,hedge_leverage)['apr']
                    rows.append(('neutral_carry_apr',ts,apr,f'Theoretical carry; JLP leverage={leverage:g}; HL leverage={hedge_leverage:g}; total capital incl. margin'))
            rows.sort(key=lambda row:row[1])
            if p.path.endswith('.csv'):
                buf=io.StringIO();w=csv.writer(buf);w.writerow(['metric','timestamp_utc','value','source'])
                for k,t,v,s in rows:w.writerow([k,datetime.fromtimestamp(t/1000,__import__('datetime').timezone.utc).isoformat(),v,s])
                return self.send(buf.getvalue(),'text/csv; charset=utf-8')
            series={}
            for k,t,v,s in rows:series.setdefault(k,[]).append([t,v])
            # Bucket dense local samples for efficient charting; retain exact data in SQLite/CSV.
            for k,points in series.items():
                if len(points)>1600 and not k in ['funding_BTC','funding_ETH','funding_SOL','jlp_apr_archive']:
                    bucket=max(1000,int(days*86400000/1200)); grouped={}
                    for t,v in points:grouped[t//bucket]=[t,v]
                    series[k]=list(grouped.values())
            return self.send(json.dumps(series,allow_nan=False))
        if p.path.startswith('/api/'):
            self.send_error(404);return
        super().do_GET()

if __name__=='__main__':
    for name,fn,interval in [('pool',pool,10),('loan',loan,15),('price',price,15),('funding',funding,10),('strategy',strategy,10),('activity',activity,20),('liquidations',liquidations,15),('history',history,3600),('persistence',persist,60)]:
        threading.Thread(target=loop,args=(name,fn,interval),daemon=True).start()
    port=int(os.environ.get('JLP_PORT','8788'))
    print(f'JLP research dashboard: http://127.0.0.1:{port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
