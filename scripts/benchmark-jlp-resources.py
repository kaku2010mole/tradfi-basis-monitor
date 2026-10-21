#!/usr/bin/env python3
"""Offline A/B: identical fixtures/requests, isolated DB, no network/recorder.

Run each side in a fresh process. Hashes must match before reporting savings.
CPU is process CPU seconds, memory is peak process RSS (not whole-service RAM).
Example: python3 scripts/benchmark-jlp-resources.py --baseline-ref 63d5975 --days 7
"""
import argparse
import gc
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
NOW = 1792573200  # fixed clock; both versions see exactly the same range

def worker(service, days, mode):
    with tempfile.TemporaryDirectory(prefix='jlp-perf-data-') as directory:
        os.environ['JLP_DATA_DIR'] = directory
        db = Path(directory)/'research.sqlite3'
        shutil.copy2(service/'data/research.sqlite3', db)
        # Keep real source/cache shapes; replace samples with a deterministic
        # minute-sampled fixture, including real gaps and hourly funding.
        with sqlite3.connect(db) as c:
            c.execute('DELETE FROM samples')
            metrics = [('nav',5.5),('premium',-.1),('price',5.49),('borrow_apr',6),
                       ('carry_fee_1x',8),('carry_funding_1x',6),('carry_borrow_apr',5),
                       ('carry_margin_notional_1x',.6),('funding_live_BTC',.0001),
                       ('funding_live_ETH',.0002),('funding_live_SOL',-.0001),('gross_oi',1e9)]
            start = NOW*1000-days*86400000
            for day in range(days):
                batch=[]
                for minute in range(1440):
                    ts=start+(day*1440+minute)*60000
                    if minute%251 == 0: continue  # no fabricated gap filling
                    batch.extend((k,ts,v,'fixture') for k,v in metrics)
                    if minute%60 == 0: batch.extend((f'funding_{coin}',ts,.001,'settled') for coin in ['BTC','ETH','SOL'])
                c.executemany('INSERT INTO samples VALUES (?,?,?,?)',batch)
        sys.path.insert(0,str(service))
        spec=importlib.util.spec_from_file_location('server_under_test',service/'server.py')
        server=importlib.util.module_from_spec(spec);spec.loader.exec_module(server)
        # No main loop or upstream network is started by importing the module.
        server.time.time=lambda: NOW
        digest=hashlib.sha256();byte_count=0
        class Sink:
            def write(self,data):
                nonlocal byte_count
                digest.update(data);byte_count+=len(data)
        sink=Sink()
        handler=object.__new__(server.Handler)
        handler.wfile=sink
        handler.send_response=lambda *args:None
        handler.send_header=lambda *args:None
        handler.end_headers=lambda:None
        handler.send=lambda body,ctype='':sink.write(body.encode())
        handler.path=f'/api/{"export.csv" if mode=="csv" else "history"}?days={days}&leverage=2&hedgeLeverage=10'
        gc.collect();start_cpu=time.process_time();start_wall=time.perf_counter()
        for iteration in range(3):
            if mode=='persist':
                for i in range(60):
                    server.store('loan',dict(apr=6+i/100,fetchedAt=NOW*1000),[('borrow_apr',NOW*1000+i,6+i/100,'fixture')])
            else:handler.do_GET()
        cpu=time.process_time()-start_cpu;wall=time.perf_counter()-start_wall
        rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1048576 if sys.platform=='darwin' else 1024)
        if mode=='persist':
            with sqlite3.connect(db) as c:
                digest.update(json.dumps(c.execute('SELECT * FROM samples ORDER BY metric,ts,source').fetchall()).encode())
                digest.update(json.dumps(c.execute('SELECT * FROM cache ORDER BY name').fetchall()).encode())
        print(json.dumps(dict(mode=mode,days=days,iterations=3,cpuSeconds=cpu,wallSeconds=wall,peakRssMiB=rss,bytes=byte_count,sha256=digest.hexdigest())),flush=True)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-ref',default='63d5975')
    parser.add_argument('--baseline-dir',type=Path)
    parser.add_argument('--days',type=int,choices=range(1,91),default=7)
    parser.add_argument('--runs',type=int,default=3)
    parser.add_argument('--worker',type=Path)
    parser.add_argument('--mode',choices=['history','csv','persist'],default='history')
    args=parser.parse_args()
    if args.worker:return worker(args.worker,args.days,args.mode)
    with tempfile.TemporaryDirectory(prefix='jlp-perf-baseline-') as directory:
        if args.baseline_dir: baseline=args.baseline_dir/'services/jlp-research'
        else:
            archive=subprocess.run(['git','archive',args.baseline_ref,'services/jlp-research'],cwd=REPO,check=True,stdout=subprocess.PIPE).stdout
            subprocess.run(['tar','-x','-C',directory],input=archive,check=True)
            baseline=Path(directory)/'services/jlp-research'
        results={}
        for mode in ['history','csv','persist']:
            readings={'before':[],'after':[]}
            for iteration in range(args.runs):
                # Alternate order to reduce warm-cache / thermal bias.
                for label in (['before','after'] if iteration%2==0 else ['after','before']):
                    service=baseline if label=='before' else REPO/'services/jlp-research'
                    output=subprocess.check_output([sys.executable,__file__,'--worker',str(service),'--days',str(args.days),'--mode',mode],text=True)
                    readings[label].append(json.loads(output))
            assert len({r['sha256'] for values in readings.values() for r in values})==1, f'{mode}: outputs changed'
            result={label:{key:round(statistics.median(r[key] for r in values),4) for key in ['cpuSeconds','wallSeconds','peakRssMiB','bytes']} for label,values in readings.items()}
            result['identicalOutput']=True
            result['reductionPercent']={key:round(100*(1-result['after'][key]/result['before'][key]),2) for key in ['cpuSeconds','wallSeconds','peakRssMiB']}
            results[mode]=result
            print(json.dumps(dict(mode=mode,**result)),flush=True)
        print(json.dumps(dict(days=args.days,runs=args.runs,scope='isolated processes, identical offline workloads',results=results)),flush=True)

if __name__=='__main__':main()
