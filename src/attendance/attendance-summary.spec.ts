import { AttendanceStatus } from '@prisma/client';
import { tally } from './attendance-summary';

const { PRESENT, ABSENT, LATE, EXCUSED } = AttendanceStatus;

describe('tally', () => {
  it('is all zeros for no records', () => {
    expect(tally([])).toEqual({
      daysOpen: 0,
      present: 0,
      absent: 0,
      late: 0,
      excused: 0,
      rate: 0,
    });
  });

  it('counts late as present and excused as absent', () => {
    expect(tally([PRESENT, PRESENT, LATE, ABSENT, EXCUSED])).toEqual({
      daysOpen: 5,
      present: 3,
      absent: 2,
      late: 1,
      excused: 1,
      rate: 60,
    });
  });

  it('rounds the rate to one decimal place', () => {
    expect(tally([PRESENT, PRESENT, ABSENT]).rate).toBe(66.7);
  });
});
