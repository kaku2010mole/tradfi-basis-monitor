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
        self.dbpatch.start();self.statepatch.start();self.pendingpatch.start()
        with server.connect() as c:
            c.executescript('CREATE TABLE samples(metric TEXT,ts INTEGER,value REAL,source TEXT,PRIMARY KEY(metric,ts,source)); CREATE TABLE cache(name TEXT PRIMARY KEY,body TEXT);')
        self.now=int(time.time())
    def tearDown(self):
        self.pendingpatch.stop();self.statepatch.stop();self.dbpatch.stop();self.temp.cleanup()
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

    def test_live_updates_write_only_latest_value_at_minute_flush(self):
        ts=self.now*1000
        for i in range(6):server.store('loan',dict(fetchedAt=ts,apr=i,error=None),[('borrow_apr',ts+i,i,'Jupiter JLP Loan')])
        self.assertEqual(server.STATE['loan']['apr'],5)
        with server.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM samples').fetchone()[0],0)
        with patch.object(server.time,'time',return_value=self.now):server.persist()
        with server.connect() as c:
            rows=c.execute('SELECT ts,value FROM samples').fetchall()
            self.assertEqual(rows,[(ts//60000*60000,5)])
        server.store('loan',dict(fetchedAt=ts,apr=6,error=None),[('borrow_apr',ts,6,'Jupiter JLP Loan')])
        with patch.object(server.time,'time',return_value=self.now):server.persist()
        with server.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM samples').fetchone()[0],1)
        server.store('loan',dict(fetchedAt=ts+60000,apr=7,error=None),[('borrow_apr',ts+60000,7,'Jupiter JLP Loan')])
        with patch.object(server.time,'time',return_value=self.now+60):server.persist()
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

if __name__=='__main__':unittest.main()
