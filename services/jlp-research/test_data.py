"""Verify stale-price handling and financial units with isolated local storage."""
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
import server

class DataTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.dbpatch=patch.object(server,'DB',Path(self.temp.name)/'test.sqlite3')
        self.statepatch=patch.object(server,'STATE',{})
        self.pendingpatch=patch.object(server,'PENDING',{})
        self.dirtypatch=patch.object(server,'DIRTY_CACHE',set())
        self.dbpatch.start();self.statepatch.start();self.pendingpatch.start();self.dirtypatch.start()
        with server.connect() as c:
            c.executescript('CREATE TABLE samples(metric TEXT,ts INTEGER,value REAL,source TEXT,PRIMARY KEY(metric,ts,source)); CREATE TABLE cache(name TEXT PRIMARY KEY,body TEXT);')
        self.now=int(time.time())
    def tearDown(self):
        self.dirtypatch.stop();self.pendingpatch.stop();self.statepatch.stop();self.dbpatch.stop();self.temp.cleanup()
    def mock_price(self,source_age=0):
        d={server.JLP:dict(usdPrice=9.9,blockId=100,priceChange24h=-1)}
        return patch.object(server,'fetch',side_effect=[d,dict(result=self.now-source_age)])
    def test_fresh_discount_and_history(self):
        server.STATE['pool']=dict(nav=10,fetchedAt=self.now*1000,error=None)
        with self.mock_price():server.price()
        self.assertAlmostEqual(server.STATE['price']['premium'],-1)
        server.persist()
        with server.connect() as c:self.assertEqual(c.execute("SELECT COUNT(*) FROM samples WHERE metric='premium'").fetchone()[0],1)
    def test_old_price_never_produces_premium(self):
        server.STATE['pool']=dict(nav=10,fetchedAt=self.now*1000,error=None)
        with self.mock_price(300):server.price()
        self.assertNotIn('premium',server.STATE['price'])
    def test_old_nav_never_produces_premium(self):
        server.STATE['pool']=dict(nav=10,fetchedAt=(self.now-300)*1000,error=None)
        with self.mock_price():server.price()
        self.assertNotIn('premium',server.STATE['price'])
    def test_failed_refresh_retains_last_value_and_timestamp(self):
        server.STATE['loan']=dict(apr=6.05,fetchedAt=123)
        server.fail('loan',RuntimeError('offline'))
        self.assertEqual(server.STATE['loan']['apr'],6.05)
        self.assertEqual(server.STATE['loan']['fetchedAt'],123)
        self.assertEqual(server.STATE['loan']['error'],'offline')
    def test_nav_and_rate_units(self):
        d=dict(jlpPriceUsd='5000000',jlpAprPct='8.40',jlpApyPct='8.76',jlpAprLastUpdatedTimestamp=str(self.now),aumUsd='100000000000',custodies=[])
        with patch.object(server,'fetch',return_value=d):server.pool()
        self.assertEqual(server.STATE['pool']['nav'],5)
        self.assertEqual(server.STATE['pool']['apr'],8.4)
        self.assertEqual(server.STATE['pool']['apy'],8.76)
    def test_hourly_funding_percentage_and_simple_annualization(self):
        d=[dict(universe=[dict(name=c) for c in ['BTC','ETH','SOL']]),[dict(funding='0.0000125',markPx='1',oraclePx='1') for _ in range(3)]]
        with patch.object(server,'fetch',return_value=d):server.funding()
        self.assertAlmostEqual(server.STATE['funding']['coins']['BTC']['hourly'],0.00125)
        self.assertAlmostEqual(server.STATE['funding']['coins']['BTC']['annual'],10.95)

    def test_delta_hedge_matches_finite_difference_of_custody_aum(self):
        # Independent price perturbation: guaranteed USD has no price delta,
        # locked tokens reduce delta, and traders' shorts increase pool delta.
        cs=[]
        expected={}
        for coin,dec,px,owned,locked,short in [('WBTC',8,10000,2,.5,2000),('ETH',8,2000,10,4,200),('SOL',9,100,40,10,0)]:
            guaranteed=1000;avg=px
            def aum(p):return guaranteed+(owned-locked)*p+short*(p/avg-1)
            eps=px*.00001;delta=(aum(px+eps)-aum(px-eps))/(2*eps)
            c=dict(symbol=coin,owned=str(round(owned*10**dec)),locked=str(round(locked*10**dec)),globalShortSizes=str(short*10**6),globalShortAveragePrice=str(px*10**6),guaranteedUsd=str(guaranteed*10**6),aumUsd=str(round(aum(px)*1e6)),currentWeightagePct='1')
            cs.append(c);expected['BTC' if coin=='WBTC' else coin]=(delta*px/100000*100,delta/10000)
        d=dict(aumUsd='100000000000',jlpTotalSupply='10000000000',custodies=cs)
        h=server.derive_hedges(d)
        for coin,(ratio,qty) in expected.items():
            self.assertAlmostEqual(h[coin]['ratio'],ratio,places=7)
            self.assertAlmostEqual(h[coin]['unitsPerJlp'],qty,places=9)

    def test_one_x_has_zero_borrow_cost_and_all_hedges_earn_funding(self):
        self.assertEqual(server.leveraged_apr(8,6,99,1),14)
        self.assertEqual(server.leveraged_apr(8,6,5,2),23)

    def test_activity_uses_locked_tokens_not_guaranteed_usd_for_long_oi(self):
        h={coin:dict(lockedTokens=2,shortUsd=50,guaranteedUsd=9999) for coin in server.MARKETS}
        m={coin:dict(price='100',volume='1000') for coin in server.MARKETS}
        a=server.derive_activity(h,m)
        self.assertEqual(a['totals']['longOi'],600)
        self.assertEqual(a['totals']['shortOi'],150)
        self.assertEqual(a['totals']['grossOi'],750)
        self.assertEqual(a['totals']['oneSidedOi'],375)
        self.assertEqual(a['totals']['volume24h'],3000)
        self.assertEqual(a['totals']['longShare'],80)

    def test_activity_stale_pool_cannot_create_fake_oi_or_liquidation_zero(self):
        server.STATE['pool']=dict(fetchedAt=(self.now-60)*1000,error=None)
        with patch.object(server,'fetch',return_value=dict(price='100',volume='1000')):
            with self.assertRaises(ValueError):server.activity()
        self.assertNotIn('activity',server.STATE)

    def test_activity_records_no_fabricated_liquidation_metrics(self):
        server.STATE['pool']=dict(fetchedAt=self.now*1000,error=None,
            hedges={coin:dict(lockedTokens=2,shortUsd=50) for coin in server.MARKETS})
        with patch.object(server,'fetch',return_value=dict(price='100',volume='1000')):server.activity()
        self.assertEqual(server.STATE['activity']['liquidationCoverage'],'separate_chain_feed')
        server.persist()
        with server.connect() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM samples WHERE metric LIKE '%liquidat%'").fetchone()[0],0)
            self.assertEqual(c.execute('SELECT COUNT(DISTINCT ts) FROM samples').fetchone()[0],1)

    def test_negative_funding_reduces_return(self):
        self.assertEqual(server.leveraged_apr(8,-6,5,2),-1)

    def test_hl_ten_x_margin_included_in_total_capital(self):
        # $10k JLP equity at 2x and 60% hedge => $12k short,
        # $1,200 margin at HL 10x. $2,300 annual carry / $11,200.
        r=server.total_capital_carry(8,6,5,.6,2,10)
        self.assertAlmostEqual(r['capitalFactor'],1.12)
        self.assertAlmostEqual(r['apr'],2300/11200*100)

    def test_invalid_parameters_are_rejected(self):
        for l in [0,11,float('nan')]:
            with self.assertRaises(ValueError):server.leveraged_apr(8,6,5,l)
        with self.assertRaises(ValueError):server.total_capital_carry(8,6,5,.6,2,0)

    def test_strategy_refuses_stale_input_and_uses_oracle_for_funding(self):
        now=self.now*1000
        p=dict(fetchedAt=now,nav=10,apr=8,hedges={c:dict(unitsPerJlp=.02) for c in ['BTC','ETH','SOL']})
        q=dict(fetchedAt=now,sourceAt=now,price=10)
        l=dict(fetchedAt=now,apr=5,maxLtv=90)
        f=dict(fetchedAt=now,coins={c:dict(oracle=100,mark=110,annual=10) for c in ['BTC','ETH','SOL']})
        s=server.neutral_carry(p,q,l,f,now)
        self.assertAlmostEqual(s['fundingAprPer1x'],6)
        self.assertAlmostEqual(s['marginNotionalPer1x'],.66)
        l['fetchedAt']=now-60000
        with self.assertRaises(ValueError):server.neutral_carry(p,q,l,f,now)

    def test_live_updates_write_immediately_and_upsert_within_minute(self):
        ts=self.now//60*60000
        for i in range(6):server.store('loan',dict(fetchedAt=self.now*1000,apr=i,error=None),[('borrow_apr',ts+i,i,'Jupiter JLP Loan')])
        self.assertEqual(server.STATE['loan']['apr'],5)
        with server.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM samples').fetchone()[0],1)
        with patch.object(server.time,'time',return_value=self.now):server.persist()
        with server.connect() as c:
            rows=c.execute('SELECT ts,value FROM samples').fetchall()
            self.assertEqual(rows,[(ts//60000*60000,5)])
        server.store('loan',dict(fetchedAt=self.now*1000,apr=6,error=None),[('borrow_apr',ts,6,'Jupiter JLP Loan')])
        with patch.object(server.time,'time',return_value=self.now):server.persist()
        with server.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM samples').fetchone()[0],1)
        with patch.object(server.time,'time',return_value=ts/1000+60):
            server.store('loan',dict(fetchedAt=ts+60000,apr=7,error=None),[('borrow_apr',ts+60000,7,'Jupiter JLP Loan')])
        with server.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM samples').fetchone()[0],2)

    def test_minute_strategy_components_remain_aligned_and_stale_samples_skip(self):
        ts=self.now*1000
        rows=[(k,ts,v,'Point-in-time theoretical carry') for k,v in [('carry_fee_1x',8),('carry_funding_1x',6),('carry_borrow_apr',5),('carry_margin_notional_1x',.6)]]
        server.store('strategy',dict(fetchedAt=ts,error=None),rows)
        server.store('pool',dict(fetchedAt=ts-120000,error=None),[('nav',ts-120000,5,'Jupiter official')])
        with patch.object(server.time,'time',return_value=self.now):server.persist()
        with server.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(DISTINCT ts), COUNT(*) FROM samples').fetchone(),(1,4))
            self.assertEqual(c.execute("SELECT COUNT(*) FROM samples WHERE metric='nav'").fetchone()[0],0)

    def test_failed_refresh_cannot_erase_observed_history(self):
        ts=self.now*1000
        server.store('loan',dict(fetchedAt=ts,apr=6),[('borrow_apr',ts,6,'Jupiter JLP Loan')])
        server.fail('loan',RuntimeError('temporary timeout'))
        with patch.object(server.time,'time',return_value=self.now+180):server.persist()
        with server.connect() as c:
            self.assertEqual(c.execute('SELECT ts,value FROM samples').fetchall(),[(ts//60000*60000,6)])

    def test_failed_disk_write_retries_all_original_minutes(self):
        ts=self.now//60*60000
        for i in range(3):
            observed=ts+i*60000
            with patch.object(server.time,'time',return_value=observed/1000),patch.object(server,'connect',side_effect=sqlite3.OperationalError('disk busy')):
                with self.assertRaises(sqlite3.OperationalError):
                    server.store('loan',dict(fetchedAt=observed,apr=i),[('borrow_apr',observed,i,'Jupiter JLP Loan')])
            server.fail('loan',RuntimeError('disk busy'))
        self.assertEqual(len(server.PENDING),3)
        with patch.object(server.time,'time',return_value=self.now+300):server.persist()
        with server.connect() as c:
            self.assertEqual(c.execute('SELECT ts,value FROM samples ORDER BY ts').fetchall(),[(ts+i*60000,i) for i in range(3)])
        self.assertFalse(server.PENDING)

    def test_reopen_reads_saved_sample_without_flush_or_memory(self):
        ts=self.now*1000
        server.store('loan',dict(fetchedAt=ts,apr=6),[('borrow_apr',ts,6,'Jupiter JLP Loan')])
        server.STATE.clear();server.PENDING.clear()
        with server.connect() as c:
            self.assertEqual(c.execute('SELECT value FROM samples').fetchone()[0],6)
            self.assertEqual(json.loads(c.execute("SELECT body FROM cache WHERE name='loan'").fetchone()[0])['apr'],6)

    def test_persist_only_serializes_changed_sources_and_idle_does_not_open_database(self):
        server.store('history',dict(points=list(range(10000))))
        with patch.object(server.json,'dumps',wraps=json.dumps) as dumps:
            server.store('loan',dict(apr=7,fetchedAt=self.now*1000))
            self.assertEqual(dumps.call_count,1)
            self.assertEqual(dumps.call_args.args[0]['apr'],7)
        written_at=server.LAST_WRITE
        with patch.object(server,'connect',side_effect=AssertionError('idle database write')),patch.object(server.time,'time',return_value=self.now+100):
            server.persist()
        self.assertEqual(server.LAST_WRITE,written_at,'idle ticks never invent a successful write')
        server.fail('loan',RuntimeError('offline'))
        server.persist()
        with server.connect() as c:
            self.assertEqual(json.loads(c.execute("SELECT body FROM cache WHERE name='loan'").fetchone()[0])['error'],'offline')

    def test_failed_commit_keeps_dirty_cache_for_retry(self):
        with patch.object(server,'connect',side_effect=sqlite3.OperationalError('disk busy')):
            with self.assertRaises(sqlite3.OperationalError):server.store('loan',dict(apr=6))
        self.assertEqual(server.DIRTY_CACHE,{'loan'})
        server.persist()
        self.assertFalse(server.DIRTY_CACHE)
        with server.connect() as c:
            self.assertEqual(json.loads(c.execute("SELECT body FROM cache WHERE name='loan'").fetchone()[0])['apr'],6)

    def test_streamed_history_and_csv_exactly_match_previous_algorithm(self):
        import csv,io
        from datetime import datetime,timezone
        rows=[]
        for i in range(1805):
            ts=1000000+i*60000
            rows.extend([(k,ts,v,'source') for k,v in [('nav',5+i/1000),('funding_BTC',.01),('carry_fee_1x',8),('carry_funding_1x',6),('carry_borrow_apr',5),('carry_margin_notional_1x',.6)]])
            if i%2:rows.append(('sparse',ts,9,'source'))
        # Multiple sources at one timestamp and incomplete carry groups.
        rows.extend([('nav',1000000,7,'second source'),('carry_fee_1x',999999,1,'partial'),('jlp_apr_archive',999998,8,'archive, "quoted"\n韩文')])
        with server.connect() as c:
            c.executemany('INSERT INTO samples VALUES (?,?,?,?)',rows)
            c.execute('CREATE INDEX samples_by_ts ON samples(ts)')
        for leverage,hedge_leverage in [(1,1),(2,10),(10,40)]:
            with server.connect() as c:
                old=c.execute('SELECT metric,ts,value,source FROM samples WHERE ts>=? ORDER BY ts',(0,)).fetchall()
                snapshots={}
                for k,t,v,s in old:
                    if k in server.CARRY_COMPONENTS:snapshots.setdefault(t,{})[k]=v
                for ts,x in snapshots.items():
                    if len(x)==4:
                        apr=server.total_capital_carry(x['carry_fee_1x'],x['carry_funding_1x'],x['carry_borrow_apr'],x['carry_margin_notional_1x'],leverage,hedge_leverage)['apr']
                        old.append(('neutral_carry_apr',ts,apr,f'Theoretical carry; JLP leverage={leverage:g}; HL leverage={hedge_leverage:g}; total capital incl. margin'))
                old.sort(key=lambda row:row[1])
                self.assertEqual(list(server.history_rows(c,0,leverage,hedge_leverage)),old)
                expected={}
                for k,t,v,s in old:expected.setdefault(k,[]).append([t,v])
                for k,points in expected.items():
                    if len(points)>1600 and k not in server.UNBUCKETED_METRICS:
                        bucket=max(1000,int(7*86400000/1200));grouped={}
                        for t,v in points:grouped[t//bucket]=[t,v]
                        expected[k]=list(grouped.values())
                self.assertEqual(server.history_series(server.history_rows(c,0,leverage,hedge_leverage),7),expected)
                buf=io.StringIO();w=csv.writer(buf);w.writerow(['metric','timestamp_utc','value','source'])
                for k,t,v,s in old:w.writerow([k,datetime.fromtimestamp(t/1000,timezone.utc).isoformat(),v,s])
                with tempfile.SpooledTemporaryFile(max_size=1024,mode='w+b') as raw:
                    server.write_history_csv(raw,server.history_rows(c,0,leverage,hedge_leverage))
                    self.assertTrue(raw._rolled)
                    raw.seek(0);self.assertEqual(raw.read(),buf.getvalue().encode())
        with server.connect() as c:
            self.assertEqual(server.history_series(server.history_rows(c,10**15,2,10),7),{})
        for count in [1599,1600,1601]:
            raw=[('nav',i,1,'source') for i in range(count)]
            self.assertEqual(len(server.history_series(iter(raw),7)['nav']),count if count<=1600 else 1)

if __name__=='__main__':unittest.main()
