# Pump.fun Paper Sprint: Supply-Absorption Breakout bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/emasinves0-commits/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/emasinves0-commits/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the `agent-fun/replay/v2` pump.fun harness (Node 22, `main.ts`).
It reads the hello once, then answers every batch with a list of orders. No network, no clock,
no randomness: two runs produce byte-identical action logs.

## Strategy

`main.ts` holds three entry modes behind one `mode` parameter; the default is `B`.

- **B, supply-absorption breakout (default).** Sellers showed up in the last 20 slots yet the
  price held within 10% of its prior high, then it breaks that high by 2% with net buyers in
  control this slot.
- **A, absorb-exhaust.** Enter after a flush (>= 10% under the local high) once net buyer steps
  beat seller steps for 2 slots, with no creator sell and no big-holder dump; larger size near
  completion.
- **C, flush-reclaim only.** Flush plus absorption, without the holder filter.

Shared rules: each coin is judged once, buys carry 1% max slippage (a refused buy costs nothing),
size is capped at 1% of the coin's real SOL reserve, at most 5 open positions. Exits: take-profit
+20%, stop-loss -6%, trailing stop (arms at +10%, exits on an 8% fall from the peak), a 20-slot
hold limit and an instant exit on a creator sell.

A breadth fallback buys 0.0105 SOL probes when the run falls behind a pace of one filled coin
per 3,500 slots (about 29 per 6 hours), so the 20-coin guardrail holds on the final window.

## Files

- `main.ts`: the bot (`createBot(params)` plus the entrypoint)
- `vendor/makefun-bot.ts`: the kit's SDK shim, unmodified
- `LICENSE`: MIT
