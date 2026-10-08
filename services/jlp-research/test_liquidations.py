import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from monitoring import jupiter_liquidations as feed

def fixture():
    schema=next(e for e in feed.IDL['events'] if e['name']=='LiquidateFullPositionEvent')
    values={'pool':feed.POOL,'positionMint':'So11111111111111111111111111111111111111112',
        'positionSide':2,'positionSizeUsd':25000000000,'price':118526326,'liquidationFeeUsd':7500000}
    payload=b''
    for field in schema['fields']:
        typ=field['type'];value=values.get(field['name'],0)
        if typ=='publicKey':payload+=feed.unbase58(value) if isinstance(value,str) else b'\0'*32
        else:payload+=int(value).to_bytes({'u8':1,'bool':1,'u64':8,'i64':8}[typ],'little',signed=typ=='i64')
    raw=bytes.fromhex('e445a52e51cb9a1d')+hashlib.sha256(b'event:LiquidateFullPositionEvent').digest()[:8]+payload
    return dict(slot=100,blockTime=1000,transaction={'message':{'accountKeys':[feed.PROGRAM]}},
        meta={'err':None,'innerInstructions':[{'index':2,'instructions':[{'programIdIndex':0,'data':feed.base58(raw)}]}],'logMessages':[]})

class LiquidationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.dbpatch=patch.object(feed,'DB',Path(self.temp.name)/'events.sqlite3');self.dbpatch.start()
        self.seedpatch=patch.object(feed,'RECOVERY_SEED',Path(self.temp.name)/'recovery.json');self.seedpatch.start()
    def tearDown(self):
        self.seedpatch.stop()
        self.dbpatch.stop();self.temp.cleanup()
    def test_recovery_seed_only_initializes_empty_database(self):
        feed.RECOVERY_SEED.write_text(json.dumps({'state':{'cursor':'saved','coverage_since':'100'},
            'events':[{'eventId':'saved:1','observedAt':110,'decoded':False}]}))
        with feed.connect() as db:
            self.assertEqual(feed.state(db,'cursor'),'saved')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0],1)
            feed.save_state(db,'cursor','advanced')
            db.commit()
        with feed.connect() as db:
            self.assertEqual(feed.state(db,'cursor'),'advanced')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0],1)
    def test_units_and_verified_program(self):
        tx=fixture();event=feed.extract(tx,'signature')[0]
        self.assertEqual((event['market'],event['side'],event['sizeUsd'],event['priceUsd'],event['liquidationFeeUsd']),('SOL','short',25000,118.526326,7.5))
        self.assertEqual(event['eventId'],'signature:2:0')
        tx['transaction']['message']['accountKeys']=['11111111111111111111111111111111']
        self.assertEqual(feed.extract(tx,'unrelated'),[])
    def test_failed_transactions_are_not_liquidations(self):
        tx=fixture();tx['meta']['err']={'InstructionError':[0,'Custom']}
        self.assertEqual(feed.extract(tx,'failed'),[])
    def test_restart_dedup_and_checkpoint(self):
        with feed.connect() as db:
            feed.save_state(db,'cursor','old');db.commit()
        def rpc(method,params):
            if method=='getSignaturesForAddress':return [dict(signature='new',err=None,blockTime=1000),dict(signature='old',err=None,blockTime=999)]
            return fixture()
        with patch.object(feed,'rpc',side_effect=rpc),patch.object(feed.time,'sleep'):
            with feed.connect() as db:
                self.assertEqual(feed.poll(db)['newEvents'],1)
            with feed.connect() as db:
                self.assertEqual(feed.poll(db)['newEvents'],0)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0],1)
                self.assertEqual(feed.state(db,'cursor'),'new')
    def test_v1_transaction_is_read_and_checkpointed(self):
        with feed.connect() as db:
            feed.save_state(db,'cursor','old');db.commit()
        def rpc(method,params):
            if method=='getSignaturesForAddress':
                return [dict(signature='v1',err=None,blockTime=1000),dict(signature='old',err=None,blockTime=999)]
            self.assertEqual(method,'getTransaction')
            self.assertEqual(params[1]['maxSupportedTransactionVersion'],1)
            tx=fixture();tx['version']=1
            tx['transaction']['message']['transactionConfig']={'computeUnitLimit':30000}
            return tx
        with patch.object(feed,'rpc',side_effect=rpc),patch.object(feed.time,'sleep'):
            with feed.connect() as db:
                self.assertEqual(feed.poll(db)['newEvents'],1)
                self.assertEqual(feed.state(db,'cursor'),'v1')
    def test_rate_limit_backs_off_without_advancing_checkpoint(self):
        with feed.connect() as db:
            feed.save_state(db,'cursor','old');db.commit()
            with patch.object(feed,'poll',side_effect=feed.RateLimited('RPC HTTP 429')) as poller,patch.object(feed.time,'time',return_value=1000):
                with self.assertRaises(feed.RateLimited):feed.poll_with_backoff(db)
                self.assertEqual(feed.state(db,'cursor'),'old')
                self.assertEqual(feed.state(db,'retry_after'),'1120')
                self.assertTrue(feed.poll_with_backoff(db)['rateLimited'])
                self.assertEqual(poller.call_count,1)
    def test_unavailable_transaction_keeps_checkpoint(self):
        with feed.connect() as db:
            feed.save_state(db,'cursor','old');db.commit()
            with patch.object(feed,'rpc',side_effect=[[dict(signature='new',err=None),dict(signature='old',err=None)],None]):
                with self.assertRaisesRegex(RuntimeError,'checkpoint retained'):feed.poll(db)
            self.assertEqual(feed.state(db,'cursor'),'old')
    def test_truncated_event_reports_unknown_not_zero(self):
        tx=fixture();ix=tx['meta']['innerInstructions'][0]['instructions'][0]
        ix['data']=feed.base58(feed.unbase58(ix['data'])[:20])
        event=feed.extract(tx,'truncated')[0]
        self.assertFalse(event['decoded'])
        self.assertNotIn('sizeUsd',event)
    def test_summary_retains_partial_coverage(self):
        with feed.connect() as db:
            feed.save_state(db,'started_at',900);feed.save_state(db,'last_success',1000)
            snapshot=feed.snapshot(db,now=1010)
            self.assertTrue(snapshot['connected']);self.assertTrue(snapshot['partial24h'])
            feed.save_state(db,'last_error','HTTP 429')
            self.assertFalse(feed.snapshot(db,now=1010)['connected'])
            self.assertEqual(feed.snapshot(db,now=1010)['error'],'HTTP 429')

if __name__=='__main__':unittest.main()
