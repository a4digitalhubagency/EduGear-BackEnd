import { AttendanceStatus } from '@prisma/client';

export interface AttendanceTally {
  daysOpen: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  rate: number;
}

/**
 * Report-card attendance from a student's marks. Late counts as present — the
 * child was in school — and excused counts as absent, because the report card
 * question is "how many days were you here?", not "were you excused?".
 */
export function tally(statuses: readonly AttendanceStatus[]): AttendanceTally {
  const count = (status: AttendanceStatus) =>
    statuses.filter((value) => value === status).length;

  const late = count(AttendanceStatus.LATE);
  const excused = count(AttendanceStatus.EXCUSED);
  const present = count(AttendanceStatus.PRESENT) + late;
  const absent = count(AttendanceStatus.ABSENT) + excused;
  const daysOpen = statuses.length;

  return {
    daysOpen,
    present,
    absent,
    late,
    excused,
    rate: daysOpen === 0 ? 0 : Math.round((present / daysOpen) * 1000) / 10,
  };
}
