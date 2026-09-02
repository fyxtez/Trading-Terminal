type PriceCoordinateSeries = {
  priceToCoordinate: (price: number) => number | null;
  coordinateToPrice: (coordinate: number) => number | null;
};

const finiteOrNull = (value: number | null | undefined): number | null =>
  value !== null && value !== undefined && Number.isFinite(value)
    ? value
    : null;

/**
 * FIX: Lightweight Charts can return null or a non-finite coordinate from the
 * candle series when every candle is outside the viewport. Validate the result
 * instead of using `??`, then use the future anchor that shares the right scale.
 */
export const priceToCoordinateWithFutureFallback = (
  candleSeries: PriceCoordinateSeries | null,
  futureSeries: PriceCoordinateSeries | null,
  price: number,
): number | null =>
  finiteOrNull(candleSeries?.priceToCoordinate(price)) ??
  finiteOrNull(futureSeries?.priceToCoordinate(price));

/**
 * FIX: apply the same finite-value guard to pointer-to-price conversion so
 * drawings and alert repositioning continue to work in an all-future viewport.
 */
export const coordinateToPriceWithFutureFallback = (
  candleSeries: PriceCoordinateSeries | null,
  futureSeries: PriceCoordinateSeries | null,
  coordinate: number,
): number | null =>
  finiteOrNull(candleSeries?.coordinateToPrice(coordinate)) ??
  finiteOrNull(futureSeries?.coordinateToPrice(coordinate));
