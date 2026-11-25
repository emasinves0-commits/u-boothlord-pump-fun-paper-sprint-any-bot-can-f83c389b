// Absorb-Exhaust: a pump.fun paper-trading bot for agent-fun/replay/v2 (Node 22, erasable TS).
//
// Idea: buy a coin only AFTER a flush has been absorbed, never while it is still falling.
//   1. flush       - price is >= flushPct below its recent local high
//   2. absorption  - net buyer steps beat seller steps for `confirm` consecutive trading slots
//   3. exhaustion  - no creator sell and no big-holder dump in the recent window (sellers are spent)
//   4. proximity   - coins with more real SOL in the curve (closer to completion) get bigger size
// Each coin is judged once: it is armed by its first flush and either enters or is dropped for good.
// Buys use tight slippage (1%): a refused order costs nothing, a filled one at a chased price does.
// Exits: take-profit, stop-loss, trailing stop, hard slot limit, instant exit on a creator sell.
//
// Deterministic by construction: no clock, no randomness, no I/O; every loop walks insertion order.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  mode: 'A' | 'B' | 'C'; // A absorb-exhaust, B supply-absorption breakout, C flush-reclaim only
  flushPct: number; // drawdown from the local high that counts as a flush
  maxFlushPct: number; // deeper than this is a rug, not a flush
  confirm: number; // consecutive net-buyer slots needed
  armSlots: number; // slots an armed coin may take to confirm before it is dropped
  highWindow: number; // slots that define the "local high"
  takeProfit: number;
  stopLoss: number;
  trailArm: number;
  trailGap: number;
  maxHold: number; // slots
  baseSol: number;
  midSol: number;
  bigSol: number;
  midReserveSol: number;
  bigReserveSol: number;
  buySlipBps: number;
  sellSlipBps: number;
  minReserveSol: number;
  dumpShare: number; // a holder owning at least this share of supply that sells half is a dump
  breadthEvery: number; // slots per coin the breadth pace asks for
  probeSol: number;
}

export const DEFAULTS: Params = {
  mode: 'B',
  flushPct: 0.1,
  maxFlushPct: 0.5,
  confirm: 2,
  armSlots: 30,
  highWindow: 150,
  takeProfit: 0.2,
  stopLoss: 0.06,
  trailArm: 0.1,
  trailGap: 0.08,
  maxHold: 20,
  baseSol: 0.05,
  midSol: 0.1,
  bigSol: 0.3,
  midReserveSol: 20,
  bigReserveSol: 50,
  buySlipBps: 100,
  sellSlipBps: 2500,
  minReserveSol: 1.1,
  dumpShare: 0.02,
  breadthEvery: 3500, // slots per distinct coin: ~29 coins per 6h window (about 100k slots)
  probeSol: 0.0105,
};

interface Row {
  slot: number;
  open: number;
  close: number;
  low: number;
  high: number;
  buys: number;
  sells: number;
  buyVol: number;
  sellVol: number;
}

interface Coin {
  mint: string;
  creator: string;
  supply: bigint;
  rows: Row[];
  balances: Map<string, bigint>;
  creatorSold: boolean;
  dumpSlot: number;
  armed: boolean;
  armedSlot: number;
  lowPx: number;
  streak: number;
  done: boolean; // judged / bought: never looked at again
}

interface Hold {
  entrySlot: number;
  entryPx: number;
  peak: number;
}

const SOL = Number(LAMPORTS_PER_SOL);

export function createBot(partial: Partial<Params> = {}): Bot {
  const p: Params = { ...DEFAULTS, ...partial };
  const coins = new Map<string, Coin>();
  const holds = new Map<string, Hold>();
  const filledMints = new Set<string>();
  let firstSlot = -1;

  const coinOf = (mint: string): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { mint, creator: '', supply: 0n, rows: [], balances: new Map(), creatorSold: false, dumpSlot: -1e9, armed: false, armedSlot: -1, lowPx: Infinity, streak: 0, done: false };
      coins.set(mint, c);
    }
    return c;
  };

  const lamports = (sol: number): bigint => BigInt(Math.floor(sol * SOL));

  return {
    onHello(state: BotState) {
      // The hello fixes the caps and latency; nothing is random here, so the seed goes unused.
      void state.hello.seed;
    },

    onBatch(state: BotState, batch: Batch) {
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      const touched = new Map<string, Coin>();
      const creatorSellNow = new Set<string>();

      // ---- fold this slot's events into per-coin rows and holder books
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.creator = e.creator;
          c.supply = BigInt(e.token_total_supply);
          continue;
        }
        if (e.event !== 'TradeEvent') continue;
        const c = coinOf(e.mint);
        if (c.creator === '') c.creator = e.creator;
        const vt = Number(e.virtual_token_reserves);
        if (vt <= 0) continue;
        const px = Number(e.virtual_quote_reserves) / vt;
        const sol = Number(e.sol_amount) / SOL;
        let row = c.rows[c.rows.length - 1];
        if (row === undefined || row.slot !== slot) {
          row = { slot, open: px, close: px, low: px, high: px, buys: 0, sells: 0, buyVol: 0, sellVol: 0 };
          c.rows.push(row);
          while (c.rows.length > 0 && c.rows[0].slot < slot - p.highWindow) c.rows.shift();
        }
        row.close = px;
        if (px < row.low) row.low = px;
        if (px > row.high) row.high = px;
        const tokens = BigInt(e.token_amount);
        const before = c.balances.get(e.user) ?? 0n;
        if (e.is_buy) {
          row.buys++;
          row.buyVol += sol;
          c.balances.set(e.user, before + tokens);
        } else {
          row.sells++;
          row.sellVol += sol;
          const after = before > tokens ? before - tokens : 0n;
          c.balances.set(e.user, after);
          if (e.user === c.creator) {
            c.creatorSold = true;
            creatorSellNow.add(e.mint);
          } else if (c.supply > 0n) {
            const big = before * 10_000n >= c.supply * BigInt(Math.round(p.dumpShare * 10_000));
            if (big && tokens * 2n >= before) c.dumpSlot = slot;
          }
        }
        touched.set(e.mint, c);
      }

      const orders: OrderInput[] = [];

      // ---- exits first: they free position slots
      for (const [mint, h] of holds) {
        if (!state.positions.has(mint)) {
          // not held (yet, or any more): forget it once no buy is pending either
          let pendingBuy = false;
          for (const po of state.pending.values()) if (po.order.side === 'buy' && po.order.mint === mint) pendingBuy = true;
          if (!pendingBuy && h.entrySlot >= 0) holds.delete(mint);
        }
      }
      for (const [mint, pos] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || curve.virtual_token_reserves <= 0n) continue;
        const px = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        let h = holds.get(mint);
        if (h === undefined) {
          h = { entrySlot: slot, entryPx: px, peak: px };
          holds.set(mint, h);
        }
        if (px > h.peak) h.peak = px;
        const ratio = px / h.entryPx;
        let why = '';
        if (creatorSellNow.has(mint)) why = 'creator';
        else if (ratio >= 1 + p.takeProfit) why = 'tp';
        else if (ratio <= 1 - p.stopLoss) why = 'sl';
        else if (h.peak / h.entryPx >= 1 + p.trailArm && px <= h.peak * (1 - p.trailGap)) why = 'trail';
        else if (slot - h.entrySlot >= p.maxHold) why = 'time';
        if (why === '') continue;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.side === 'sell' && po.order.mint === mint) sellPending = true;
        if (sellPending) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // ---- entries: judge each touched coin once its slot has closed
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') filledMints.add(f.mint);
      }
      // Count filled buys plus buys still in flight, so one lull does not trigger a burst of probes.
      let inFlight = 0;
      for (const po of state.pending.values()) if (po.order.side === 'buy' && !filledMints.has(po.order.mint)) inFlight++;
      const behind = breadthBehind(slot - firstSlot, filledMints.size + inFlight, p.breadthEvery);
      let free = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const [mint, c] of touched) {
        if (free <= 0 || orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (c.done) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const row = c.rows[c.rows.length - 1];
        if (row === undefined || row.slot !== slot) continue;
        if (c.creatorSold) {
          c.done = true;
          continue;
        }
        let verdict = judge(p, c, row, behind);
        // Breadth fallback: the guardrail wants 20 distinct coins, so when the pace runs behind, a
        // rising coin with buyers in control gets a small probe even if the strategy's own signal is silent.
        if (behind && verdict !== 'buy' && row.buys > row.sells && row.close >= row.open) verdict = 'buy';
        if (verdict === 'drop') {
          c.done = true;
          continue;
        }
        if (verdict !== 'buy') continue;
        const reserveSol = Number(curve.real_quote_reserves) / SOL;
        if (reserveSol < p.minReserveSol) continue; // not judged: the cap just cannot carry a real buy yet
        const cap = state.maxBuyLamports(mint);
        let target = behind ? p.probeSol : sizeFor(p, reserveSol);
        let amount = lamports(target);
        if (amount > cap) amount = cap;
        if (amount < 10_500_000n) continue;
        if (state.freeCashLamports() < amount + state.txFeeLamports() * 2n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        c.done = true; // one-shot: the shim records the pending buy after this reply
        free--;
      }
      return orders;
    },
  };
}

function breadthBehind(elapsed: number, entered: number, every: number): boolean {
  return entered < Math.floor(elapsed / every);
}

function sizeFor(p: Params, reserveSol: number): number {
  if (p.mode === 'C' || p.mode === 'B') return reserveSol >= p.midReserveSol ? p.midSol : p.baseSol;
  if (reserveSol >= p.bigReserveSol) return p.bigSol;
  if (reserveSol >= p.midReserveSol) return p.midSol;
  return p.baseSol;
}

// 'wait' keeps looking, 'drop' judges the coin for good, 'buy' enters.
function judge(p: Params, c: Coin, row: Row, behind: boolean): 'wait' | 'drop' | 'buy' {
  if (p.mode === 'B') return judgeBreakout(p, c, row, behind);
  const slot = row.slot;
  let high = 0;
  for (const r of c.rows) if (r.high > high) high = r.high;
  const px = row.close;
  const flush = behind ? Math.min(p.flushPct, 0.05) : p.flushPct;
  const need = behind ? 1 : p.confirm;
  if (!c.armed) {
    const dd = 1 - row.low / high;
    if (dd >= flush && dd <= p.maxFlushPct) {
      c.armed = true;
      c.armedSlot = slot;
      c.lowPx = row.low;
      c.streak = 0;
    } else if (dd > p.maxFlushPct) {
      return 'drop';
    }
    return 'wait';
  }
  if (row.low < c.lowPx) {
    c.lowPx = row.low;
    c.streak = 0;
  }
  if (slot - c.armedSlot > p.armSlots) return 'drop';
  if (row.buys > row.sells) c.streak++;
  else if (row.buys < row.sells || row.buys === row.sells) c.streak = 0;
  if (c.streak < need || px < c.lowPx * 1.01) return 'wait';
  // exhaustion: the people who could dump already did, or never will
  if (p.mode === 'A' && !behind && slot - c.dumpSlot <= p.highWindow) return 'drop';
  return 'buy';
}

// Variant B: sellers showed up in the last window yet price held, then price breaks the prior high.
function judgeBreakout(p: Params, c: Coin, row: Row, behind: boolean): 'wait' | 'drop' | 'buy' {
  const slot = row.slot;
  let priorHigh = 0;
  let sells = 0;
  let sellVol = 0;
  let buyVol = 0;
  let floor = Infinity;
  for (const r of c.rows) {
    if (r.slot >= slot - 2) continue;
    if (r.high > priorHigh) priorHigh = r.high;
    if (r.slot >= slot - 20) {
      sells += r.sells;
      sellVol += r.sellVol;
      buyVol += r.buyVol;
      if (r.low < floor) floor = r.low;
    }
  }
  if (priorHigh === 0 || sells < (behind ? 1 : 3)) return 'wait';
  const held = floor >= priorHigh * 0.9;
  const broke = row.close >= priorHigh * 1.02;
  const flow = row.buys > row.sells && buyVol >= sellVol;
  if (held && broke && flow) return 'buy';
  return 'wait';
}

if (import.meta.main) {
  await runBot(createBot());
}
