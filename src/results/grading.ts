import { Prisma } from '@prisma/client';

/**
 * Grade bands and the assessment scheme, both validated as a whole: a scale
 * with a gap leaves some total ungradeable, and a scheme not worth 100 marks
 * makes every percentage on the report card wrong.
 */

export interface GradeBandInput {
  grade: string;
  minScore: number;
  maxScore: number;
  remark: string;
  isPass: boolean;
}

/** The WAEC/NECO scale most Nigerian secondary schools already print. */
export const WAEC_GRADE_BANDS: readonly GradeBandInput[] = [
  {
    grade: 'A1',
    minScore: 75,
    maxScore: 100,
    remark: 'Excellent',
    isPass: true,
  },
  {
    grade: 'B2',
    minScore: 70,
    maxScore: 74,
    remark: 'Very Good',
    isPass: true,
  },
  { grade: 'B3', minScore: 65, maxScore: 69, remark: 'Good', isPass: true },
  { grade: 'C4', minScore: 60, maxScore: 64, remark: 'Credit', isPass: true },
  { grade: 'C5', minScore: 55, maxScore: 59, remark: 'Credit', isPass: true },
  { grade: 'C6', minScore: 50, maxScore: 54, remark: 'Credit', isPass: true },
  { grade: 'D7', minScore: 45, maxScore: 49, remark: 'Pass', isPass: true },
  { grade: 'E8', minScore: 40, maxScore: 44, remark: 'Pass', isPass: true },
  { grade: 'F9', minScore: 0, maxScore: 39, remark: 'Fail', isPass: false },
];

/** The common 3 × CA + exam split. */
export const DEFAULT_ASSESSMENT_COMPONENTS = [
  { name: '1st CA', maxScore: 10 },
  { name: '2nd CA', maxScore: 10 },
  { name: '3rd CA', maxScore: 10 },
  { name: 'Exam', maxScore: 70 },
] as const;

/**
 * Returns the problems with a scale, or none. Bands are whole marks; a total of
 * 74.5 falls in the band whose range contains its floor, so the scale must be
 * contiguous in whole numbers from 0 to 100.
 */
export function validateGradeBands(bands: readonly GradeBandInput[]): string[] {
  const problems: string[] = [];
  if (bands.length === 0) return ['A grading scale needs at least one band'];

  const grades = new Set<string>();
  for (const band of bands) {
    const key = band.grade.trim().toUpperCase();
    if (grades.has(key)) problems.push(`Grade ${band.grade} appears twice`);
    grades.add(key);
    if (!Number.isInteger(band.minScore) || !Number.isInteger(band.maxScore)) {
      problems.push(`Grade ${band.grade} must use whole marks`);
    }
    if (band.minScore > band.maxScore) {
      problems.push(`Grade ${band.grade} starts above where it ends`);
    }
  }
  if (problems.length) return problems;

  const sorted = [...bands].sort((a, b) => a.minScore - b.minScore);
  if (sorted[0].minScore !== 0) {
    problems.push(`Nothing covers 0–${sorted[0].minScore - 1}`);
  }
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (current.minScore <= previous.maxScore) {
      problems.push(`Grades ${previous.grade} and ${current.grade} overlap`);
    } else if (current.minScore > previous.maxScore + 1) {
      problems.push(
        `Nothing covers ${previous.maxScore + 1}–${current.minScore - 1}, between ${previous.grade} and ${current.grade}`,
      );
    }
  }
  const top = sorted[sorted.length - 1];
  if (top.maxScore !== 100) {
    problems.push(
      top.maxScore < 100
        ? `Nothing covers ${top.maxScore + 1}–100`
        : 'The scale cannot go above 100',
    );
  }

  return problems;
}

export function gradeFor<
  T extends Pick<GradeBandInput, 'minScore' | 'maxScore'>,
>(total: Prisma.Decimal, bands: readonly T[]): T | null {
  // 74.5 is not yet 75: a band is reached by whole marks, never rounded up.
  const whole = total.floor().toNumber();
  return (
    bands.find((band) => whole >= band.minScore && whole <= band.maxScore) ??
    null
  );
}

export interface ComponentInput {
  name: string;
  maxScore: number;
}

export function validateAssessmentScheme(
  components: readonly ComponentInput[],
): string[] {
  const problems: string[] = [];
  if (components.length === 0) {
    return ['An assessment scheme needs at least one component'];
  }

  const names = new Set<string>();
  for (const component of components) {
    const key = component.name.trim().toLowerCase();
    if (names.has(key)) problems.push(`"${component.name}" appears twice`);
    names.add(key);
    if (!Number.isInteger(component.maxScore) || component.maxScore < 1) {
      problems.push(
        `"${component.name}" must be worth a whole number of marks`,
      );
    }
  }

  const total = components.reduce(
    (sum, component) => sum + component.maxScore,
    0,
  );
  if (total !== 100) {
    problems.push(
      `The components add up to ${total}; they must add up to 100 so every total is a percentage`,
    );
  }

  return problems;
}
