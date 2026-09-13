import { Prisma } from '@prisma/client';
import { gradeFor } from './grading';
import { competitionRank } from './ranking';

/**
 * Computes a class arm's term results from raw scores.
 *
 * Pure, so every rule is pinned by a unit test rather than discovered on a
 * report card:
 *
 *  - A subject total is the sum of its component scores; its grade comes from
 *    the school's bands, reached by whole marks and never rounded up.
 *  - A compulsory subject counts for every student. An elective counts only for
 *    students with at least one score in it — they are the ones taking it.
 *  - A student's average is their total over the subjects they take, so a
 *    student with fewer electives is not penalised against one with more.
 *  - Class position ranks averages; subject position ranks subject totals.
 *    Ties share a place ("1st, 2nd, 2nd, 4th").
 *  - A missing score counts as zero in a preview and is listed, so a draft can
 *    be looked at before every teacher has finished — but a sheet with missing
 *    scores cannot be submitted.
 */

const ZERO = new Prisma.Decimal(0);

export interface ComputeStudent {
  id: string;
}

export interface ComputeSubject {
  id: string;
  name: string;
  compulsory: boolean;
}

export interface ComputeComponent {
  id: string;
  name: string;
  maxScore: number;
}

export interface ComputeScore {
  studentId: string;
  subjectId: string;
  componentId: string;
  score: Prisma.Decimal;
}

export interface ComputeBand {
  grade: string;
  minScore: number;
  maxScore: number;
  remark: string;
  isPass: boolean;
}

export interface ComputedComponentScore {
  componentId: string;
  name: string;
  maxScore: number;
  score: Prisma.Decimal | null;
}

export interface ComputedSubject {
  subjectId: string;
  subjectName: string;
  components: ComputedComponentScore[];
  total: Prisma.Decimal;
  grade: string | null;
  remark: string | null;
  isPass: boolean;
  position: number;
  complete: boolean;
}

export interface ComputedStudent {
  studentId: string;
  subjects: ComputedSubject[];
  total: Prisma.Decimal;
  average: Prisma.Decimal;
  subjectCount: number;
  /** Null when the student takes no subjects at all. */
  position: number | null;
  complete: boolean;
}

export interface SubjectStats {
  subjectId: string;
  subjectName: string;
  highest: Prisma.Decimal;
  lowest: Prisma.Decimal;
  average: Prisma.Decimal;
  studentCount: number;
}

export interface MissingScores {
  studentId: string;
  subjectId: string;
  componentIds: string[];
}

export interface ComputeResult {
  students: ComputedStudent[];
  subjectStats: SubjectStats[];
  missing: MissingScores[];
  /** Students ranked for class position (those taking at least one subject). */
  rankedCount: number;
}

export function computeResults(input: {
  students: readonly ComputeStudent[];
  subjects: readonly ComputeSubject[];
  components: readonly ComputeComponent[];
  scores: readonly ComputeScore[];
  bands: readonly ComputeBand[];
}): ComputeResult {
  const { students, subjects, components, bands } = input;

  const scoreOf = new Map<string, Prisma.Decimal>();
  const touched = new Set<string>();
  for (const score of input.scores) {
    scoreOf.set(
      `${score.studentId}|${score.subjectId}|${score.componentId}`,
      score.score,
    );
    touched.add(`${score.studentId}|${score.subjectId}`);
  }

  const missing: MissingScores[] = [];
  const computed: ComputedStudent[] = students.map((student) => {
    const taken = subjects.filter(
      (subject) =>
        subject.compulsory || touched.has(`${student.id}|${subject.id}`),
    );

    const subjectResults: ComputedSubject[] = taken.map((subject) => {
      const parts = components.map((component) => ({
        componentId: component.id,
        name: component.name,
        maxScore: component.maxScore,
        score:
          scoreOf.get(`${student.id}|${subject.id}|${component.id}`) ?? null,
      }));

      const absent = parts.filter((part) => part.score === null);
      if (absent.length > 0) {
        missing.push({
          studentId: student.id,
          subjectId: subject.id,
          componentIds: absent.map((part) => part.componentId),
        });
      }

      const total = parts.reduce<Prisma.Decimal>(
        (sum, part) => sum.add(part.score ?? ZERO),
        ZERO,
      );
      const band = gradeFor(total, bands);

      return {
        subjectId: subject.id,
        subjectName: subject.name,
        components: parts,
        total,
        grade: band?.grade ?? null,
        remark: band?.remark ?? null,
        isPass: band?.isPass ?? false,
        position: 0,
        complete: absent.length === 0,
      };
    });

    const total = subjectResults.reduce<Prisma.Decimal>(
      (sum, subject) => sum.add(subject.total),
      ZERO,
    );
    const average =
      subjectResults.length === 0
        ? ZERO
        : total
            .div(subjectResults.length)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    return {
      studentId: student.id,
      subjects: subjectResults,
      total,
      average,
      subjectCount: subjectResults.length,
      position: null,
      complete: subjectResults.every((subject) => subject.complete),
    };
  });

  // Class position, by average.
  const ranked = computed.filter((student) => student.subjectCount > 0);
  const classRanks = competitionRank(ranked, (student) => student.average);
  for (const student of ranked) {
    student.position = classRanks.get(student) ?? null;
  }

  // Subject positions and class statistics, per subject.
  const subjectStats: SubjectStats[] = [];
  for (const subject of subjects) {
    const entries = computed.flatMap((student) =>
      student.subjects.filter((result) => result.subjectId === subject.id),
    );
    if (entries.length === 0) continue;

    const ranks = competitionRank(entries, (entry) => entry.total);
    for (const entry of entries) entry.position = ranks.get(entry) ?? 0;

    const totals = entries.map((entry) => entry.total);
    const sum = totals.reduce<Prisma.Decimal>(
      (acc, value) => acc.add(value),
      ZERO,
    );
    subjectStats.push({
      subjectId: subject.id,
      subjectName: subject.name,
      highest: Prisma.Decimal.max(...totals),
      lowest: Prisma.Decimal.min(...totals),
      average: sum
        .div(entries.length)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      studentCount: entries.length,
    });
  }

  return {
    students: computed,
    subjectStats,
    missing,
    rankedCount: ranked.length,
  };
}
