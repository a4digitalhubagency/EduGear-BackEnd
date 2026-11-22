import {
  COMMISSION_NOTIFICATION_WINDOW_HOURS,
  commissionDeadline,
  hoursUntilDeadline,
  isWindowClosed,
  needsAttention,
  notificationState,
} from './breach-clock';

const DISCOVERED = new Date('2026-03-02T09:00:00.000Z');
/** 72 hours later, to the millisecond. */
const DEADLINE = new Date('2026-03-05T09:00:00.000Z');

const hoursAfterDiscovery = (hours: number) =>
  new Date(DISCOVERED.getTime() + hours * 60 * 60 * 1000);

describe('the window', () => {
  it('is the 72 hours section 40(2) allows', () => {
    expect(COMMISSION_NOTIFICATION_WINDOW_HOURS).toBe(72);
  });

  it('runs from discovery, not from when the breach began', () => {
    expect(commissionDeadline(DISCOVERED)).toEqual(DEADLINE);
  });

  it('crosses month boundaries without drifting', () => {
    const lateMonth = new Date('2026-01-30T22:00:00.000Z');
    expect(commissionDeadline(lateMonth)).toEqual(
      new Date('2026-02-02T22:00:00.000Z'),
    );
  });

  it('does not stretch for weekends', () => {
    // 72 hours is 72 hours. A Friday discovery is due on Monday, and a
    // register that quietly skipped the weekend would mislead the one person
    // relying on it.
    const friday = new Date('2026-03-06T10:00:00.000Z');
    expect(commissionDeadline(friday)).toEqual(
      new Date('2026-03-09T10:00:00.000Z'),
    );
  });
});

describe('hoursUntilDeadline', () => {
  it('counts down', () => {
    expect(hoursUntilDeadline(DISCOVERED, DISCOVERED)).toBe(72);
    expect(hoursUntilDeadline(DISCOVERED, hoursAfterDiscovery(50))).toBe(22);
  });

  it('goes negative once the deadline passes', () => {
    expect(hoursUntilDeadline(DISCOVERED, hoursAfterDiscovery(81))).toBe(-9);
  });

  it('truncates rather than rounds up', () => {
    // 90 seconds left is not "1 hour remaining".
    const almost = new Date(DEADLINE.getTime() - 90 * 1000);
    expect(hoursUntilDeadline(DISCOVERED, almost)).toBe(0);
  });
});

describe('isWindowClosed', () => {
  it('is false right up to the deadline', () => {
    expect(isWindowClosed(DISCOVERED, hoursAfterDiscovery(71))).toBe(false);
    expect(isWindowClosed(DISCOVERED, DEADLINE)).toBe(false);
  });

  it('is true a millisecond after', () => {
    expect(isWindowClosed(DISCOVERED, new Date(DEADLINE.getTime() + 1))).toBe(
      true,
    );
  });
});

describe('notificationState', () => {
  it('is DUE while the window is open and nothing has been sent', () => {
    expect(
      notificationState({ discoveredAt: DISCOVERED }, hoursAfterDiscovery(10)),
    ).toBe('DUE');
  });

  it('is OVERDUE once the window closes with nothing sent', () => {
    expect(
      notificationState({ discoveredAt: DISCOVERED }, hoursAfterDiscovery(73)),
    ).toBe('OVERDUE');
  });

  it('is ON_TIME when notified inside the window', () => {
    expect(
      notificationState(
        {
          discoveredAt: DISCOVERED,
          commissionNotifiedAt: hoursAfterDiscovery(12),
        },
        hoursAfterDiscovery(200),
      ),
    ).toBe('ON_TIME');
  });

  it('counts notifying exactly on the deadline as on time', () => {
    // "within 72 hours" includes the 72nd hour.
    expect(
      notificationState(
        { discoveredAt: DISCOVERED, commissionNotifiedAt: DEADLINE },
        hoursAfterDiscovery(200),
      ),
    ).toBe('ON_TIME');
  });

  it('is LATE when notified after the window closed', () => {
    expect(
      notificationState(
        {
          discoveredAt: DISCOVERED,
          commissionNotifiedAt: new Date(DEADLINE.getTime() + 1),
        },
        hoursAfterDiscovery(200),
      ),
    ).toBe('LATE');
  });

  it('is NOT_REQUIRED when a reason was recorded', () => {
    expect(
      notificationState(
        {
          discoveredAt: DISCOVERED,
          notificationNotRequiredReason:
            'Encrypted backup, key not exposed; no risk to rights or freedoms',
        },
        hoursAfterDiscovery(500),
      ),
    ).toBe('NOT_REQUIRED');
  });

  it('does not let a blank reason excuse an overdue breach', () => {
    // An empty string is not an assessment. Treating it as one would turn the
    // safest-looking field into the one that hides a missed deadline.
    for (const reason of ['', '   ', null, undefined]) {
      expect(
        notificationState(
          {
            discoveredAt: DISCOVERED,
            notificationNotRequiredReason: reason,
          },
          hoursAfterDiscovery(100),
        ),
      ).toBe('OVERDUE');
    }
  });

  it('reports what actually happened over what was decided', () => {
    // If it was assessed as not required and then notified anyway, the record
    // should say it was notified. The Commission cares about the act.
    expect(
      notificationState(
        {
          discoveredAt: DISCOVERED,
          commissionNotifiedAt: hoursAfterDiscovery(5),
          notificationNotRequiredReason: 'Initially assessed as low risk',
        },
        hoursAfterDiscovery(200),
      ),
    ).toBe('ON_TIME');
  });
});

describe('needsAttention', () => {
  it('flags anything overdue', () => {
    expect(
      needsAttention({ discoveredAt: DISCOVERED }, hoursAfterDiscovery(80)),
    ).toBe(true);
  });

  it('flags a deadline inside the warning window', () => {
    expect(
      needsAttention({ discoveredAt: DISCOVERED }, hoursAfterDiscovery(50)),
    ).toBe(true);
  });

  it('leaves a fresh breach alone', () => {
    expect(
      needsAttention({ discoveredAt: DISCOVERED }, hoursAfterDiscovery(2)),
    ).toBe(false);
  });

  it('leaves settled breaches alone', () => {
    const now = hoursAfterDiscovery(200);
    expect(
      needsAttention(
        { discoveredAt: DISCOVERED, commissionNotifiedAt: DEADLINE },
        now,
      ),
    ).toBe(false);
    expect(
      needsAttention(
        { discoveredAt: DISCOVERED, notificationNotRequiredReason: 'No risk' },
        now,
      ),
    ).toBe(false);
  });

  it('honours a custom warning window', () => {
    const at60 = hoursAfterDiscovery(60);
    expect(needsAttention({ discoveredAt: DISCOVERED }, at60, 6)).toBe(false);
    expect(needsAttention({ discoveredAt: DISCOVERED }, at60, 24)).toBe(true);
  });
});
