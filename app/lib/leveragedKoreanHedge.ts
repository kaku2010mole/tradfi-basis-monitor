export type LeveragedKoreanHedge = {
  productHkd: number;
  productUsd: number;
  impliedStockKrw: number;
  stockShares: number;
  stockExposureUsd: number;
  stockExposureKrw: number;
};

/**
 * Local-return scenario used by the dedicated 7709/7747 monitor:
 * d(product USD value)/value ≈ beta × [d(stock USD)/stock USD + d(USD/KRW)/(USD/KRW)].
 * The stock-share and FX numbers are separate first-order sensitivities, not
 * an executable order or a claim about the fund's actual swap inventory.
 */
export function leveragedKoreanHedge(
  productUnits: number,
  productPriceHkd: number,
  stockPriceUsd: number,
  usdKrw: number,
  usdHkd: number,
  beta: number,
): LeveragedKoreanHedge | null {
  if (![productUnits, productPriceHkd, stockPriceUsd, usdKrw, usdHkd, beta].every((value) => Number.isFinite(value) && value > 0)) return null;
  const productHkd = productUnits * productPriceHkd;
  const productUsd = productHkd / usdHkd;
  const stockExposureUsd = beta * productUsd;
  return {
    productHkd,
    productUsd,
    impliedStockKrw: stockPriceUsd * usdKrw,
    stockShares: stockExposureUsd / stockPriceUsd,
    stockExposureUsd,
    stockExposureKrw: stockExposureUsd * usdKrw,
  };
}
