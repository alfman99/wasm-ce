/**
 * Speed hack: run the page's own clock faster or slower without touching its code.
 *
 * Games read time in three places — `performance.now()`, `Date.now()` and the timestamp handed to a
 * `requestAnimationFrame` callback — and then feed the delta to the simulation. Wrap those three and
 * a fixed-timestep game speeds up, slows down or stops, with no frame-skipping and no editing of the
 * game loop. The agent runs at document_start, so the wrappers are in place before the app records
 * `performance.now` in a local or hands `requestAnimationFrame` to its loop.
 *
 * Everything the tool itself does stays on the real clock: freeze intervals, watch sampling and the
 * bridge timeouts are `Date.now`/`setInterval` on our side, and we never wrap our own timers.
 */
import { BridgeError } from '@wasmcheat/protocol';

/** Upper bound. Beyond this a game's own physics stops being recognisable and float maths drifts. */
export const MAX_SPEED_SCALE = 20;

export interface SpeedStatus {
  scale: number;
  installed: boolean;
}

/** The three clocks, injectable so the arithmetic can be tested without patching globals. */
export interface TimeSource {
  now(): number;
  date(): number;
  requestFrame(callback: (timestamp: number) => void): number;
}

export interface TimeMachineOptions {
  source?: Partial<TimeSource>;
}

export class TimeMachine {
  private scaleValue = 1;
  /** Start of the current segment: a scale change starts a new one so past time is never rewritten. */
  private segmentReal = 0;
  private segmentVirtual = 0;
  /** Added to virtual time to answer `Date.now()`; keeps wall-clock date continuous. */
  private dateOffset = 0;
  private installed = false;
  private readonly source: TimeSource;

  constructor(options: TimeMachineOptions = {}) {
    this.source = {
      now: options.source?.now ?? (() => performance.now()),
      date: options.source?.date ?? (() => Date.now()),
      requestFrame:
        options.source?.requestFrame ??
        ((callback) => {
          // Absent in a worker: the game there reads only `performance.now` / `Date.now`.
          if (typeof requestAnimationFrame !== 'function') return 0;
          return requestAnimationFrame(callback);
        }),
    };
    this.segmentReal = this.source.now();
    this.segmentVirtual = this.segmentReal;
    this.dateOffset = this.source.date() - this.segmentVirtual;
  }

  get scale(): number {
    return this.scaleValue;
  }

  /** Virtual milliseconds elapsed since the segment started. */
  virtual(real = this.source.now()): number {
    return this.segmentVirtual + (real - this.segmentReal) * this.scaleValue;
  }

  /**
   * Wraps the three clocks. Idempotent: a second call is a no-op, so a re-injected agent cannot
   * stack wrappers (which would multiply the scale).
   */
  install(): SpeedStatus {
    if (this.installed) return this.status();
    const realNow = performance.now.bind(performance);
    const realDate = Date.now.bind(Date);
    // A worker realm has no `window` and no `requestAnimationFrame`; there, two clocks are all there is.
    const scope = typeof window === 'undefined' ? null : window;
    const realFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : null;
    this.source.now = () => realNow();
    this.source.date = () => realDate();
    this.source.requestFrame = realFrame ? (callback) => realFrame(callback) : () => 0;
    this.segmentReal = realNow();
    this.segmentVirtual = this.segmentReal;
    this.dateOffset = realDate() - this.segmentVirtual;

    const machine = this;
    performance.now = () => machine.virtual();
    Date.now = () => machine.virtual() + machine.dateOffset;
    // A frame callback's timestamp shares the `performance.now` time base, so the scale applies to it
    // the same way. The real frame still runs at the display's pace; only the number changes.
    if (scope && realFrame) {
      scope.requestAnimationFrame = (callback: FrameRequestCallback): number =>
        realFrame((timestamp) => callback(machine.virtualTimestamp(timestamp)));
    }
    this.installed = true;
    return this.status();
  }

  set(scale: number): SpeedStatus {
    if (!Number.isFinite(scale) || scale < 0 || scale > MAX_SPEED_SCALE) {
      throw new BridgeError('BAD_PARAMS', `scale must be a number between 0 and ${MAX_SPEED_SCALE}`);
    }
    const real = this.source.now();
    const virtual = this.virtual(real);
    this.segmentReal = real;
    this.segmentVirtual = virtual;
    this.scaleValue = scale;
    return this.status();
  }

  /** Back to real time; the wrappers stay in place because callers may already hold copies. */
  reset(): SpeedStatus {
    return this.set(1);
  }

  status(): SpeedStatus {
    return { scale: this.scaleValue, installed: this.installed };
  }

  /** Real timestamp -> virtual timestamp on the same time base, for `requestAnimationFrame`. */
  virtualTimestamp(realTimestamp: number): number {
    return this.segmentVirtual + (realTimestamp - this.segmentReal) * this.scaleValue;
  }
}
