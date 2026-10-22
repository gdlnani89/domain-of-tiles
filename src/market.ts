export type TradableResource = 'WOOD' | 'FOOD' | 'STONE';
export type TradeSide = 'buy' | 'sell';

export interface MarketPriceConfig {
  basePrice: number;
  minPriceMultiplier: number;
  maxPriceMultiplier: number;
}

export const MARKET_CONFIG = {
  // Construção
  COST_WOOD: 150,
  COST_STONE: 50,
  HP: 400,
  SIZE: 3,
  BUILD_RATE_DEFAULT: 10,

  // Troca comercial
  SPREAD_SELL_MULTIPLIER: 0.75, // Vender rende 75% do preço_atual (floor)
  SPREAD_BUY_MULTIPLIER: 1.25,  // Comprar custa 125% do preço_atual (ceil)
  PRICE_IMPACT_PER_LOT: 0.03,   // 3% por lote de 100
  MIN_PRICE_MULTIPLIER: 0.50,   // Mínimo 50% da base
  MAX_PRICE_MULTIPLIER: 2.00,   // Máximo 200% da base
  RECOVERY_RATE_PER_SEC: 0.01,  // 1% da distância até a base por segundo

  // Preços base por lote de 100 unidades (em Ouro)
  BASE_PRICES: {
    WOOD: 40,
    FOOD: 40,
    STONE: 60,
  } as Record<TradableResource, number>,
};

export interface MarketPriceState {
  prices: Record<TradableResource, number>;
}

export function createInitialMarketPriceState(): MarketPriceState {
  return {
    prices: {
      WOOD: MARKET_CONFIG.BASE_PRICES.WOOD,
      FOOD: MARKET_CONFIG.BASE_PRICES.FOOD,
      STONE: MARKET_CONFIG.BASE_PRICES.STONE,
    },
  };
}

export interface PlayerResources {
  wood: number;
  food: number;
  stone: number;
  gold: number;
}

export interface TradeResult {
  ok: boolean;
  reason?: 'NO_MARKET' | 'INSUFFICIENT_RESOURCES' | 'INSUFFICIENT_GOLD' | 'INVALID';
  goldDelta?: number;
  resourceDelta?: number;
  unitPrice?: number;
  totalCostOrGain?: number;
}

/**
 * Calcula o custo de compra ou ganho de venda para 1 lote de 100 un. com base no preço atual
 */
export function getTradeRates(currentPrice: number): { sellRate: number; buyRate: number } {
  const sellRate = Math.max(1, Math.floor(currentPrice * MARKET_CONFIG.SPREAD_SELL_MULTIPLIER));
  const buyRate = Math.max(1, Math.ceil(currentPrice * MARKET_CONFIG.SPREAD_BUY_MULTIPLIER));
  return { sellRate, buyRate };
}

/**
 * Executa troca de recursos de forma pura.
 * Suporta múltiplos lotes (ex: 1 lote = 100 un, 5 lotes = 500 un).
 * Aplica variação dinâmica de preço por lote.
 */
export function executeTrade(
  playerResources: PlayerResources,
  marketState: MarketPriceState,
  hasCompletedMarket: boolean,
  resource: TradableResource,
  side: TradeSide,
  lots: number = 1
): TradeResult {
  if (!hasCompletedMarket) {
    return { ok: false, reason: 'NO_MARKET' };
  }
  if (!['WOOD', 'FOOD', 'STONE'].includes(resource)) {
    return { ok: false, reason: 'INVALID' };
  }
  if (!Number.isInteger(lots) || lots <= 0) {
    return { ok: false, reason: 'INVALID' };
  }

  const basePrice = MARKET_CONFIG.BASE_PRICES[resource];
  const minPrice = basePrice * MARKET_CONFIG.MIN_PRICE_MULTIPLIER;
  const maxPrice = basePrice * MARKET_CONFIG.MAX_PRICE_MULTIPLIER;

  let currentPrice = marketState.prices[resource] ?? basePrice;
  let totalGoldDelta = 0;
  const totalResourceAmount = lots * 100;

  if (side === 'sell') {
    const available = resource === 'WOOD' ? playerResources.wood : (resource === 'FOOD' ? playerResources.food : playerResources.stone);
    if (available < totalResourceAmount) {
      return { ok: false, reason: 'INSUFFICIENT_RESOURCES' };
    }

    // Processa lote a lote calculando ganho e impacto
    for (let l = 0; l < lots; l++) {
      const { sellRate } = getTradeRates(currentPrice);
      totalGoldDelta += sellRate;
      currentPrice = Math.max(minPrice, currentPrice * (1 - MARKET_CONFIG.PRICE_IMPACT_PER_LOT));
    }

    // Aplica recursos
    if (resource === 'WOOD') playerResources.wood -= totalResourceAmount;
    else if (resource === 'FOOD') playerResources.food -= totalResourceAmount;
    else if (resource === 'STONE') playerResources.stone -= totalResourceAmount;

    playerResources.gold += totalGoldDelta;
    marketState.prices[resource] = currentPrice;

    return {
      ok: true,
      goldDelta: totalGoldDelta,
      resourceDelta: -totalResourceAmount,
      totalCostOrGain: totalGoldDelta,
    };
  } else {
    // Simula primeiro se tem ouro suficiente
    let simulatedPrice = currentPrice;
    let requiredGold = 0;
    for (let l = 0; l < lots; l++) {
      const { buyRate } = getTradeRates(simulatedPrice);
      requiredGold += buyRate;
      simulatedPrice = Math.min(maxPrice, simulatedPrice * (1 + MARKET_CONFIG.PRICE_IMPACT_PER_LOT));
    }

    if (playerResources.gold < requiredGold) {
      return { ok: false, reason: 'INSUFFICIENT_GOLD' };
    }

    // Aplica de verdade
    currentPrice = simulatedPrice;
    playerResources.gold -= requiredGold;

    if (resource === 'WOOD') playerResources.wood += totalResourceAmount;
    else if (resource === 'FOOD') playerResources.food += totalResourceAmount;
    else if (resource === 'STONE') playerResources.stone += totalResourceAmount;

    marketState.prices[resource] = currentPrice;

    return {
      ok: true,
      goldDelta: -requiredGold,
      resourceDelta: totalResourceAmount,
      totalCostOrGain: requiredGold,
    };
  }
}

/**
 * Atualiza os preços do mercado retornando monotonicamente em direção aos preços-base
 * Taxa: 1% da distância até a base por segundo
 */
export function tickMarketPrices(marketState: MarketPriceState, dt: number): void {
  if (dt <= 0) return;
  const resources: TradableResource[] = ['WOOD', 'FOOD', 'STONE'];

  for (const res of resources) {
    const base = MARKET_CONFIG.BASE_PRICES[res];
    let curr = marketState.prices[res] ?? base;
    const diff = base - curr;

    if (Math.abs(diff) < 0.01) {
      marketState.prices[res] = base;
      continue;
    }

    // Ajuste proporcional ao tempo simulado
    const step = diff * MARKET_CONFIG.RECOVERY_RATE_PER_SEC * dt;
    if (Math.abs(step) >= Math.abs(diff)) {
      curr = base;
    } else {
      curr += step;
    }

    // Clamping de segurança
    const minPrice = base * MARKET_CONFIG.MIN_PRICE_MULTIPLIER;
    const maxPrice = base * MARKET_CONFIG.MAX_PRICE_MULTIPLIER;
    marketState.prices[res] = Math.max(minPrice, Math.min(maxPrice, curr));
  }
}
