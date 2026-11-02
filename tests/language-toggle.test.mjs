import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const read = path => readFile(new URL(path, import.meta.url),'utf8');
const catalogSource = await read('../app/lib/translationCatalog.ts');
const catalog = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(catalogSource)).toString('base64'));
const { translateInterfaceText: t } = catalog;

test('locally reviewed translations cover every dashboard and core financial meanings', () => {
  for (const label of ['JLP Research','Basis monitor','Oracle monitor','Relative value monitor','Stock cross-venue basis','Japanese stock estimates','HK auction basis','Dividend Calendar','Opening outlook','Compare cash and perpetual pricing','Funding history']) {
    assert.notEqual(t(label), label, label);
    assert.match(t(label), /[\u3400-\u9fff]/);
  }
  assert.equal(t('BUY ADR · SELL PERP'),'买入 ADR · 卖出永续');
  assert.equal(t('BUY PERP · SELL ADR'),'买入永续 · 卖出 ADR');
  assert.equal(t('BID / ASK'),'买价 / 卖价');
  assert.equal(t('SHORT'),'做空'); assert.equal(t('LONG'),'做多');
  assert.equal(t('64 reference days · through 2026-10-30'),'64 个参考日，数据截至 2026-10-30');
  assert.equal(t('  Live quote radar\n'),'  实时价差雷达\n');
  assert.equal(t('NO LIVE POSITIVE EDGE'),'暂无实时正向价差');
  assert.match(t('AVG MOVE -1.021% · DIRECTION HIT 85.7% 18/21'), /-1\.021%.*85\.7% 18\/21/);
  assert.equal(t('Following the locked ADR down signal.'),'跟随已锁定 ADR 下跌信号。');
  assert.equal(t('Binance executable best bid/ask is -0.104% from oracle, outside the ±0.100% band.'),'Binance 可成交最优买卖价相对预言机偏离 -0.104%，超出 ±0.100% 区间。');
  assert.equal(t('Hyperliquid executable best bid/ask is +0.155% from oracle, outside the ±0.100% band · 2 additional triggers.'),'Hyperliquid 可成交最优买卖价相对预言机偏离 +0.155%，超出 ±0.100% 区间；另有 2 个触发。');
});

test('codes, numbers, URLs, timestamps and user-entered numerical formats remain exact', () => {
  for (const value of ['TWTSMUSDT','MEDIATEKUSDT','JPMUFGUSDT','KRX:035720','SMH','TSM','HK.07709','USDT','USD/KRW','-2.689%','53,900 / 54,000','KRW 53,900 / 54,000','2026-11-02 09:30','https://example.com/Market?price=1.234','wss://example.com/Feed','<script>alert(1)</script>']) {
    if (value.includes('script')) { assert.ok(!t(value).includes('<img')); continue; }
    assert.equal(t(value),value,value);
  }
  assert.equal(t('TWTSMUSDT · STALE'),'TWTSMUSDT · 已过期');
  assert.equal(t('USD 26.135 / 26.152'),'USD 26.135 / 26.152');
  for (let i=0;i<catalog.TRANSLATION_CACHE_LIMIT*3;i++) t(`Current quote ${i}.12345`);
  assert.equal(t('Current quote 1.234'),'当前报价 1.234');
  assert.ok(catalog.TRANSLATION_ENTRIES.length > 900);
  assert.match(catalogSource,/cache\.size >= TRANSLATION_CACHE_LIMIT/);
});

test('all page switchers show the accessible language action beside settings', async () => {
  const bundle = await build({entryPoints:[new URL('../app/components/PageSwitcher.tsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'test-dependencies',setup(b){b.onLoad({filter:/\.css$/},()=>({contents:'export default {};',loader:'js'}));b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'import React from "react";export default function Link(p){return React.createElement("a",p,p.children)}',loader:'js'}));}}],logLevel:'silent'});
  const module={exports:{}};
  new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const html=renderToStaticMarkup(React.createElement(module.exports.default,{active:'stock-basis'}));
  assert.match(html,/Translate all pages to Chinese/);
  assert.match(html,/translate="no"/); assert.match(html,/aria-pressed="false"/);
  assert.match(html,/中文/); assert.match(html,/Switch dashboard/);
  const layout=await read('../app/layout.tsx');
  assert.match(layout,/<GlobalTranslation\s*\/>/);
  const controller=await read('../app/components/GlobalTranslation.tsx');
  assert.match(controller,/import\("\.\.\/lib\/pageTranslation"\)/,'catalog must stay lazy');
});

test('display language persists, syncs subscribers and tolerates blocked storage', async () => {
  const source=await read('../app/lib/languagePreference.ts');
  const store=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
  let value='zh-CN',calls=0;
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>value,setItem:(_,next)=>{value=next;}}});
  try {
    assert.equal(store.getServerLanguage(),'en');
    const unsubscribe=store.subscribeLanguage(()=>calls++);
    store.restoreDisplayLanguage(); assert.equal(store.getDisplayLanguage(),'zh-CN');
    store.setDisplayLanguage('en'); assert.equal(value,'en'); assert.equal(calls,2);
    store.setDisplayLanguage('en'); assert.equal(calls,2);
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});
    store.setDisplayLanguage('zh-CN'); assert.equal(store.getDisplayLanguage(),'zh-CN');
    store.restoreDisplayLanguage(); unsubscribe();
  } finally {if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;}
});

test('translation never touches feed paths, inputs or DOM structure; English has no observation timer',async()=>{
  const source=await read('../app/lib/pageTranslation.ts');
  assert.doesNotMatch(source,/\bfetch\s*\(|setInterval\s*\(|\.innerHTML\s*=|\.value\s*=/);
  assert.match(source,/new WeakMap<Text, TextRecord>/);
  assert.match(source,/if \(next === "zh-CN"\) observer\?\.observe/);
  assert.match(source,/attributeFilter: ATTRIBUTES/);
  assert.match(source,/frame\.contentDocument/);
  assert.match(source,/frame\.removeEventListener\("load"/);
  assert.match(source,/handle\.child\?\.dispose\(\)/);
  assert.match(source,/if \(previous\?\.rendered === current\) return/);
});
