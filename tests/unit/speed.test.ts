import { afterEach, describe, expect, it } from 'vitest';
import { TimeMachine } from '../../packages/page-agent/src/speed';

describe('TimeMachine', () => {
  const realNow = performance.now;
  const realDate = Date.now;

  afterEach(() => {
    performance.now = realNow;
    Date.now = realDate;
  });

  it('keeps Date.now an integer, so BigInt(Date.now()) still works on every page', () => {
    const machine = new TimeMachine();
    machine.install();
    machine.set(1.5);
    expect(Number.isInteger(Date.now())).toBe(true);
    expect(() => BigInt(Date.now())).not.toThrow();
  });
});
