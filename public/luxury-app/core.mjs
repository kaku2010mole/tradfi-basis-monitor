export const currencies = ['CNY', 'HKD', 'JPY', 'EUR', 'GBP', 'USD', 'SGD', 'KRW', 'AUD', 'CAD', 'CHF'];

export function normalizeRates(rows) {
  if (!Array.isArray(rows)) throw new Error('汇率响应格式错误');
  const rates = { CNY: 1 }, dates = { CNY: null };
  for (const row of rows) {
    if (row.base !== 'CNY' || !currencies.includes(row.quote)) continue;
    if (!Number.isFinite(row.rate) || row.rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error('汇率数据无效');
    rates[row.quote] = 1 / row.rate;
    dates[row.quote] = row.date;
  }
  if (currencies.some(c => !rates[c])) throw new Error('汇率数据缺少币种');
  return { rates, dates, effectiveDate: Object.values(dates).filter(Boolean).sort()[0] };
}

export function calculatePrice(price, region, rule, fx, settings) {
  const amount = price?.amount;
  const rate = fx?.rates?.[region.currency];
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(rate) || rate <= 0) {
    return { available: false, local: amount ?? null, officialCny: null, afterCny: null, refundLocal: null, refundRate: 0, rate: rate ?? null, status: '尚未核实官价' };
  }
  const salesTaxRate = region.id === 'us' ? settings.usSalesTax / 100 : region.id === 'ca' ? (rule?.provincialRates?.[settings.caProvince || 'Ontario']?.total ?? 0.13) : 0;
  const localTax = amount * salesTaxRate;
  const officialCny = amount * rate;
  const baseLocal = amount + localTax;
  let eligible = Boolean(rule?.refundable) && (rule.residencyRequired === false || settings.residence !== region.id);
  if (['fr', 'it', 'de', 'es'].includes(region.id) && ['fr', 'it', 'de', 'es', 'eu'].includes(settings.residence)) eligible = false;
  if (region.id === 'cn') eligible = false; // 首版只测算中国大陆境外购物。
  const vat = rule?.vatRate ?? 0;
  const meetsMinimum = amount / (1 + vat) >= (rule?.minimumExTax ?? 0) && amount >= (rule?.minimumInclusive ?? 0);
  eligible &&= meetsMinimum;
  const isJapanStoreExemption = region.id === 'jp' && settings.tripDate < '2026-11-01';
  const fee = isJapanStoreExemption || rule?.feeApplies === false ? 0 : settings.feePercent / 100;
  const refundLocal = eligible ? amount * vat / (1 + vat) * (1 - fee) : 0;
  let status = rule?.shortLabel || '无游客退税';
  if (rule?.refundable && !eligible) status = meetsMinimum ? '居住地不符合测算资格' : '未达到退税门槛';
  if (eligible && region.id === 'jp') status = isJapanStoreExemption ? '店内免税 · 符合资格' : '离境退款 · 符合资格';
  return {
    available: true, local: amount, officialCny, afterCny: (baseLocal - refundLocal) * rate,
    refundLocal, refundRate: refundLocal / amount, rate, eligible, status,
    localTax, salesTaxRate, refundableVat: amount * vat / (1 + vat), isJapanStoreExemption
  };
}

export function sortRows(rows, sort, basis) {
  const key = basis === 'after' ? 'afterCny' : 'officialCny';
  return [...rows].sort((a, b) => {
    if (a.calculation.available !== b.calculation.available) return a.calculation.available ? -1 : 1;
    if (sort === 'region') return a.region.order - b.region.order;
    const delta = (a.calculation[key] ?? 0) - (b.calculation[key] ?? 0);
    return (sort === 'desc' ? -delta : delta) || a.region.order - b.region.order;
  });
}

export function csvCell(value) {
  let str = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(str)) str = "'" + str;
  return '"' + str.replaceAll('"', '""') + '"';
}
