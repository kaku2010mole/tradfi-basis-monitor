import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeRates, calculatePrice, sortRows, csvCell } from '../public/luxury-app/core.mjs';

const catalogue = JSON.parse(await readFile(new URL('../public/luxury-app/data/catalog.json', import.meta.url)));
const {rules} = JSON.parse(await readFile(new URL('../public/luxury-app/data/tax-rules.json', import.meta.url)));
const snapshot = JSON.parse(await readFile(new URL('../public/luxury-app/data/fx-snapshot.json', import.meta.url)));
const fx = normalizeRates(snapshot);
const settings = {residence:'cn',tripDate:'2026-10-12',feePercent:0,usSalesTax:0};
const region = id => catalogue.regions.find(r => r.id === id);
const calculate = (id, amount, options = {}) => calculatePrice({amount},region(id),rules[id],fx,{...settings,...options});
const close = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-8, `${actual} ≠ ${expected}`);

test('外币兑人民币必须取接口人民币基准报价的倒数', () => {
  for(const row of snapshot) close(fx.rates[row.quote],1/row.rate);
  assert.equal(fx.rates.CNY,1);
  assert.throws(()=>normalizeRates(snapshot.filter(r=>r.quote!=='USD')));
  assert.throws(()=>normalizeRates(snapshot.map(r=>r.quote==='EUR'?{...r,rate:0}:r)));
});
test('法国20%含税价拆税，而非直接打八折', () => {
  const c=calculate('fr',1200);
  close(c.refundLocal,200); close(c.afterCny,1000*fx.rates.EUR);
  close(calculate('fr',1200,{feePercent:20}).refundLocal,160);
  close(calculate('fr',1200,{feePercent:100}).refundLocal,0);
});
test('退税资格与门槛影响计算', () => {
  assert.equal(calculate('fr',1200,{residence:'eu'}).refundLocal,0);
  assert.equal(calculate('fr',100).refundLocal,0);
  assert.equal(calculate('jp',5499).refundLocal,0);
  assert.equal(calculate('sg',99).refundLocal,0);
  assert.equal(calculate('cn',48000).refundLocal,0);
  assert.equal(calculate('cn',48000,{residence:'hk'}).refundLocal,0);
  assert.equal(calculate('hk',50000).refundLocal,0);
  assert.equal(calculate('uk',5000).refundLocal,0);
});
test('日本2026年11月1日切换办理方式及手续费模型', () => {
  const old=calculate('jp',11000,{tripDate:'2026-10-31',feePercent:20});
  close(old.refundLocal,1000); assert.equal(old.isJapanStoreExemption,true);
  const next=calculate('jp',11000,{tripDate:'2026-11-01',feePercent:20});
  close(next.refundLocal,800); assert.equal(next.isJapanStoreExemption,false);
});
test('新加坡9%与韩国10%按含价VAT部分计算', () => {
  close(calculate('sg',1090).refundLocal,90);
  close(calculate('kr',110000).refundLocal,10000);
});
test('美国保持官网税前金额，实付参考另外加销售税', () => {
  const c=calculate('us',1000,{usSalesTax:8.875});
  close(c.officialCny,1000*fx.rates.USD);
  close(c.afterCny,1088.75*fx.rates.USD);
  assert.equal(c.refundLocal,0);
});
test('缺失官价不得变成0价，并在任何价格排序里最后展示', () => {
  const absent=calculate('fr',null);
  assert.equal(absent.available,false); assert.equal(absent.afterCny,null);
  const rows=[{region:{order:0},calculation:absent},{region:{order:1},calculation:calculate('fr',1200)},{region:{order:2},calculation:calculate('fr',2400)}];
  for(const sort of ['asc','desc','region']) assert.equal(sortRows(rows,sort,'after').at(-1).calculation.available,false);
  assert.equal(sortRows(rows,'asc','after')[0],rows[1]); assert.equal(sortRows(rows,'desc','after')[0],rows[2]);
});
test('同款数据完整性、币种、官方来源及本地图片路径', async () => {
  assert.equal(new Set(catalogue.products.map(p=>p.id)).size,catalogue.products.length);
  for(const p of catalogue.products){
    assert.ok(p.sku&&p.nameZh&&p.nameEn&&p.image);
    assert.equal(new Set(p.prices.map(v=>v.regionId)).size,p.prices.length);
    for(const price of p.prices){
      assert.equal(price.currency,region(price.regionId).currency);
      if(Number.isFinite(price.amount)){
        assert.ok(price.amount>0); assert.ok(/^https:\/\//.test(price.url));
        assert.ok(price.url.toLowerCase().includes(p.sku.toLowerCase())||price.sku==='871618AAEAX1000');
      }
    }
    if(p.image.startsWith('/assets/')) await readFile(new URL('../public/luxury-app'+p.image,import.meta.url));
  }
});
test('CSV 正确处理逗号、引号和电子表格公式前缀',()=>{
  assert.equal(csvCell('a,"b"'),'"a,""b"""');
  assert.equal(csvCell('=HYPERLINK("test")'),'"\'=HYPERLINK(""test"")"');
});

test('新增欧洲地区适用各自VAT及欧盟常住地限制',()=>{
  for (const [id,vat] of [['it',.22],['de',.19],['es',.21]]) {
    close(calculate(id,1220).refundLocal,1220*vat/(1+vat));
    assert.equal(calculate(id,1220,{residence:'eu'}).refundLocal,0);
  }
  assert.equal(calculate('it',70).refundLocal,0);
  assert.equal(calculate('de',50).refundLocal,0);
  assert.ok(calculate('es',1).refundLocal>0);
});
test('瑞士8.1%含税拆税与CHF300门槛',()=>{
  close(calculate('ch',1081).refundLocal,81);
  assert.equal(calculate('ch',299).refundLocal,0);
  assert.equal(calculate('ch',1081,{residence:'ch'}).refundLocal,0);
});
test('澳洲居民也可使用政府TRS，不扣服务商设定费用',()=>{
  close(calculate('au',1100,{residence:'au',feePercent:20}).refundLocal,100);
  assert.equal(calculate('au',299).refundLocal,0);
});
test('芬兰25.5%含税拆税、40欧元门槛与欧盟常住地限制',()=>{
  close(calculate('fi',1255).refundLocal,255);
  close(calculate('fi',1255).afterCny,1000*fx.rates.EUR);
  assert.equal(calculate('fi',39.99).refundLocal,0);
  assert.ok(calculate('fi',40).refundLocal>0);
  assert.equal(calculate('fi',1255,{residence:'eu'}).refundLocal,0);
  assert.equal(calculate('fi',1255,{residence:'fi'}).refundLocal,0);
  assert.equal(catalogue.regions.length,14);
  assert.equal(region('ca'),undefined);
  assert.equal(fx.rates.CAD,undefined);
});
