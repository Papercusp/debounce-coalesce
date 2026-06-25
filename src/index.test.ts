import { describe, it, expect } from 'vitest';
import {
  emptyFloorState,
  coalesce,
  nextDueAt,
  decideWake,
  onFire,
  withinFloor,
  clampToFloor,
  type Fire,
  type FloorConfig,
  type FloorDecision,
} from './index';

const fire = (at: number, payload = `e@${at}`, urgent = false): Fire<string> => ({ at, payload, urgent });
const cfg = (over: Partial<FloorConfig> = {}): FloorConfig => ({ minSleepMs: 1000, ...over });

describe('coalesce', () => {
  it('folds fires into a union with count/latest/urgent', () => {
    const c = coalesce([fire(10), fire(20), fire(30)]);
    expect(c.count).toBe(3);
    expect(c.latest.at).toBe(30);
    expect(c.fires.map((f) => f.at)).toEqual([10, 20, 30]);
    expect(c.urgent).toBe(false);
  });
  it('marks the union urgent if any fire is urgent', () => {
    expect(coalesce([fire(1), fire(2, 'x', true)]).urgent).toBe(true);
  });
  it('throws on empty', () => {
    expect(() => coalesce([])).toThrow();
  });
});

describe('decideWake — leading edge (default)', () => {
  it('wakes immediately on the first fire after idle (never woken)', () => {
    const d = decideWake({ lastWokenAt: null, pending: [fire(100)], now: 100, cfg: cfg() });
    expect(d.wake).toBe(true);
    if (d.wake) {
      expect(d.coalesced.count).toBe(1);
      expect(d.state.lastWokenAt).toBe(100);
      expect(d.state.pending).toEqual([]);
    }
  });

  it('suppresses a fire inside the floor window of the last wake', () => {
    // last wake at 100, floor 1000, fire at 500 → within window → suppress.
    const d = decideWake({ lastWokenAt: 100, pending: [fire(500)], now: 500, cfg: cfg() });
    expect(d.wake).toBe(false);
    if (!d.wake) expect(d.dueAt).toBe(1100); // lastWokenAt + minSleep
  });

  it('wakes once the floor window has elapsed', () => {
    const d = decideWake({ lastWokenAt: 100, pending: [fire(500), fire(900)], now: 1100, cfg: cfg() });
    expect(d.wake).toBe(true);
    if (d.wake) {
      expect(d.coalesced.count).toBe(2); // the burst coalesces into ONE wake
      expect(d.coalesced.fires.map((f) => f.at)).toEqual([500, 900]);
      expect(d.state.lastWokenAt).toBe(1100);
    }
  });
});

describe('decideWake — the exact gap: at-most-once-per-min_sleep + burst → ONE wake', () => {
  it('a hot recurring stream wakes at most once per minSleep, each carrying the union', () => {
    const c = cfg({ minSleepMs: 1000 });
    let lastWokenAt: number | null = null;
    let pending: Fire<string>[] = [];
    const wakes: number[][] = []; // the .at of fires in each wake

    // fires every 100ms for 2500ms = 26 fires (t=0..2500). Evaluate at each.
    for (let t = 0; t <= 2500; t += 100) {
      pending = [...pending, fire(t)];
      const d: FloorDecision<string> = decideWake({ lastWokenAt, pending, now: t, cfg: c });
      if (d.wake) {
        wakes.push(d.coalesced.fires.map((f) => f.at));
        lastWokenAt = d.state.lastWokenAt;
        pending = d.state.pending;
      } else {
        pending = d.state.pending;
      }
    }

    // Leading edge t=0; then floor allows t=1000, t=2000 → 3 wakes total over 2.5s.
    expect(wakes.length).toBe(3);
    expect(wakes[0]).toEqual([0]); // leading edge — one fire
    // Second wake at t=1000 coalesces everything from 100..1000.
    expect(wakes[1][0]).toBe(100);
    expect(wakes[1][wakes[1].length - 1]).toBe(1000);
    // Third wake at t=2000 coalesces 1100..2000.
    expect(wakes[2][0]).toBe(1100);
    expect(wakes[2][wakes[2].length - 1]).toBe(2000);
    // Each woken fire appears exactly once across the wakes (no loss, no dup).
    const all = wakes.flat();
    expect(all.length).toBe(new Set(all).size); // no duplicates
    // Fires 0..2000 (step 100) = 21 fires woken; 2100..2500 stay PENDING (still
    // inside the t=2000 wake's floor window — the floor working, not a loss).
    expect(all).toEqual(Array.from({ length: 21 }, (_, i) => i * 100));
    expect(all).not.toContain(2400); // correctly suppressed, awaiting the next window
  });
});

describe('decideWake — urgency bypass', () => {
  it('an urgent fire wakes immediately even inside the floor window', () => {
    const d = decideWake({ lastWokenAt: 100, pending: [fire(200), fire(300, 'boom', true)], now: 300, cfg: cfg() });
    expect(d.wake).toBe(true);
    if (d.wake) {
      expect(d.coalesced.urgent).toBe(true);
      expect(d.coalesced.count).toBe(2); // carries the suppressed non-urgent one too
    }
  });
});

describe('decideWake — max-staleness deadline', () => {
  it('forces a wake mid-window when a pending fire ages past maxStalenessMs', () => {
    const c = cfg({ minSleepMs: 10_000, maxStalenessMs: 2000 });
    // last wake at 0, floor 10s. fire at 100. Without staleness it would wait to 10000.
    const before = decideWake({ lastWokenAt: 0, pending: [fire(100)], now: 1000, cfg: c });
    expect(before.wake).toBe(false);
    if (!before.wake) expect(before.dueAt).toBe(2100); // min(0+10000, 100+2000)
    const after = decideWake({ lastWokenAt: 0, pending: [fire(100)], now: 2100, cfg: c });
    expect(after.wake).toBe(true);
  });
});

describe('decideWake — minSleep<=0 disables the floor', () => {
  it('wakes on every fire when minSleepMs is 0', () => {
    const d1 = decideWake({ lastWokenAt: 100, pending: [fire(101)], now: 101, cfg: cfg({ minSleepMs: 0 }) });
    expect(d1.wake).toBe(true);
  });
});

describe('decideWake — trailing edge', () => {
  it('never-woken + leadingEdge:false anchors the floor on the first pending fire', () => {
    const c = cfg({ minSleepMs: 1000, leadingEdge: false });
    const suppressed = decideWake({ lastWokenAt: null, pending: [fire(100)], now: 100, cfg: c });
    expect(suppressed.wake).toBe(false);
    if (!suppressed.wake) expect(suppressed.dueAt).toBe(1100); // firstAt + minSleep
    const due = decideWake({ lastWokenAt: null, pending: [fire(100)], now: 1100, cfg: c });
    expect(due.wake).toBe(true);
  });
});

describe('decideWake — empty pending', () => {
  it('does nothing with no pending fires', () => {
    const d = decideWake({ lastWokenAt: 500, pending: [], now: 9999, cfg: cfg() });
    expect(d.wake).toBe(false);
    if (!d.wake) expect(d.dueAt).toBe(null);
  });
});

describe('nextDueAt', () => {
  it('is null when nothing pending', () => {
    expect(nextDueAt({ lastWokenAt: 0, pending: [], cfg: cfg() })).toBe(null);
  });
  it('= lastWokenAt + minSleep when already woken', () => {
    expect(nextDueAt({ lastWokenAt: 100, pending: [fire(200)], cfg: cfg() })).toBe(1100);
  });
  it('pulls earlier to the staleness deadline', () => {
    expect(nextDueAt({ lastWokenAt: 100, pending: [fire(200)], cfg: cfg({ maxStalenessMs: 50 }) })).toBe(250);
  });
});

describe('onFire convenience', () => {
  it('appends to state.pending and evaluates', () => {
    let state = emptyFloorState<string>();
    const d = onFire({ state, fire: fire(10), now: 10, cfg: cfg() });
    expect(d.wake).toBe(true); // leading edge
    if (d.wake) state = d.state;
    const d2 = onFire({ state, fire: fire(20), now: 20, cfg: cfg() });
    expect(d2.wake).toBe(false); // within floor of the 10 wake
    if (!d2.wake) expect(d2.state.pending.map((f) => f.at)).toEqual([20]);
  });
});

describe('withinFloor (pot debounce half)', () => {
  it('false when never woken', () => {
    expect(withinFloor({ lastWokenAt: null, minSleepMs: 1000, now: 100 })).toBe(false);
  });
  it('true inside the window, false past it', () => {
    expect(withinFloor({ lastWokenAt: 100, minSleepMs: 1000, now: 500 })).toBe(true);
    expect(withinFloor({ lastWokenAt: 100, minSleepMs: 1000, now: 1100 })).toBe(false);
  });
  it('urgent always bypasses', () => {
    expect(withinFloor({ lastWokenAt: 100, minSleepMs: 1000, now: 500, urgent: true })).toBe(false);
  });
});

describe('clampToFloor (pot time-wake clamp)', () => {
  it('raises a too-soon requested time to now + floor', () => {
    expect(clampToFloor({ requestedAt: 1000, minSleepMs: 5000, now: 0 })).toEqual({ at: 5000, clamped: true });
  });
  it('leaves a far-enough time untouched', () => {
    expect(clampToFloor({ requestedAt: 9000, minSleepMs: 5000, now: 0 })).toEqual({ at: 9000, clamped: false });
  });
});
