import {
  MARKET_CONFIG,
  createInitialMarketPriceState,
  executeTrade,
  tickMarketPrices,
  getTradeRates,
  type PlayerResources,
  type MarketPriceState
} from './market.ts';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`FAIL: ${msg}`);
  }
}

console.log('--- Rodando Testes Unitários do Mercado ---');

// 1. Inicialização
const state: MarketPriceState = createInitialMarketPriceState();
assert(state.prices.WOOD === 40, 'Preço inicial de madeira deve ser 40');
assert(state.prices.FOOD === 40, 'Preço inicial de comida deve ser 40');
assert(state.prices.STONE === 60, 'Preço inicial de pedra deve ser 60');

const initialRates = getTradeRates(state.prices.WOOD);
assert(initialRates.sellRate === 30 && initialRates.buyRate === 50, 'Taxas iniciais de madeira devem ser 30 venda e 50 compra');

// 2. Venda de 100 de Madeira
let res: PlayerResources = { wood: 500, food: 500, stone: 500, gold: 100 };
let r1 = executeTrade(res, state, true, 'WOOD', 'sell', 1);
assert(r1.ok === true, 'Venda de 100 madeira deve funcionar');
assert(res.wood === 400, 'Madeira deve cair em 100');
assert(res.gold === 130, 'Ouro deve subir em 30 (40 * 0.75)');
assert(Math.abs(state.prices.WOOD - (40 * 0.97)) < 0.001, 'Preço da madeira deve cair 3%');

// 3. Rejeição sem mercado
let rNoMarket = executeTrade(res, state, false, 'WOOD', 'sell', 1);
assert(rNoMarket.ok === false && rNoMarket.reason === 'NO_MARKET', 'Deve rejeitar se sem mercado');

// 4. Rejeição por recurso insuficiente
res.wood = 50;
let rNoRes = executeTrade(res, state, true, 'WOOD', 'sell', 1);
assert(rNoRes.ok === false && rNoRes.reason === 'INSUFFICIENT_RESOURCES', 'Deve rejeitar venda sem recurso');

// 5. Compra de 100 de Comida
res = { wood: 500, food: 500, stone: 500, gold: 200 };
state.prices.FOOD = 40;
let rBuy = executeTrade(res, state, true, 'FOOD', 'buy', 1);
assert(rBuy.ok === true, 'Compra deve ter sucesso');
assert(res.food === 600, 'Comida deve subir em 100');
assert(res.gold === 150, 'Ouro deve descontar 50 (40 * 1.25)');
assert(Math.abs(state.prices.FOOD - (40 * 1.03)) < 0.001, 'Preço da comida deve subir 3%');

// 6. Teste de Impossibilidade de Arbitragem (Comprar e vender NUNCA gera lucro)
const resourcesToTest = ['WOOD', 'FOOD', 'STONE'] as const;
for (const r of resourcesToTest) {
  const mState = createInitialMarketPriceState();
  let playerRes: PlayerResources = { wood: 1000, food: 1000, stone: 1000, gold: 1000 };
  const initialGold = playerRes.gold;

  // Ciclo 1: Vender depois Recomprar
  executeTrade(playerRes, mState, true, r, 'sell', 1);
  executeTrade(playerRes, mState, true, r, 'buy', 1);
  assert(playerRes.gold < initialGold, `Ciclo Vender->Comprar de ${r} não pode gerar lucro!`);

  // Ciclo 2: Comprar depois Revender
  playerRes = { wood: 1000, food: 1000, stone: 1000, gold: 1000 };
  executeTrade(playerRes, mState, true, r, 'buy', 1);
  executeTrade(playerRes, mState, true, r, 'sell', 1);
  assert(playerRes.gold < initialGold, `Ciclo Comprar->Vender de ${r} não pode gerar lucro!`);
}

// 7. Limites Min / Max de Preço (50% e 200%)
const mStateLimits = createInitialMarketPriceState();
let pRes: PlayerResources = { wood: 100000, food: 100000, stone: 100000, gold: 1000000 };
for (let i = 0; i < 200; i++) {
  executeTrade(pRes, mStateLimits, true, 'WOOD', 'sell', 1);
}
assert(mStateLimits.prices.WOOD >= MARKET_CONFIG.BASE_PRICES.WOOD * 0.5 - 0.001, 'Preço de venda não pode ficar abaixo de 50%');

for (let i = 0; i < 200; i++) {
  executeTrade(pRes, mStateLimits, true, 'STONE', 'buy', 1);
}
assert(mStateLimits.prices.STONE <= MARKET_CONFIG.BASE_PRICES.STONE * 2.0 + 0.001, 'Preço de compra não pode ficar acima de 200%');

// 8. Recuperação Monotônica de Preço no Tempo
const mRec = createInitialMarketPriceState();
mRec.prices.WOOD = 20; // abaixo da base (40)
tickMarketPrices(mRec, 10);
assert(mRec.prices.WOOD > 20 && mRec.prices.WOOD < 40, 'Preço deve recuperar em direção a 40');
const pAfter10 = mRec.prices.WOOD;
tickMarketPrices(mRec, 10);
assert(mRec.prices.WOOD > pAfter10 && mRec.prices.WOOD <= 40, 'Preço deve continuar subindo monotonicamente');
tickMarketPrices(mRec, 500);
assert(mRec.prices.WOOD === 40, 'Preço deve estabilizar exatamente na base');

// 9. Lotes múltiplos (Shift+clique = 500 unidades = 5 lotes)
const mStateLots = createInitialMarketPriceState();
const pLots: PlayerResources = { wood: 1000, food: 1000, stone: 1000, gold: 1000 };
let rLots = executeTrade(pLots, mStateLots, true, 'WOOD', 'sell', 5);
assert(rLots.ok === true, 'Venda de 5 lotes deve ter sucesso');
assert(pLots.wood === 500, '500 de madeira devem ser consumidos');

console.log('✅ Todos os testes unitários do Mercado passaram com sucesso!');
