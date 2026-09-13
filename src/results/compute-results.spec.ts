import { Prisma } from '@prisma/client';
import { computeResults, ComputeScore } from './compute-results';
import { WAEC_GRADE_BANDS } from './grading';

const d = (value: number | string) => new Prisma.Decimal(value);

const components = [
  { id: 'ca', name: 'CA', maxScore: 30 },
  { id: 'exam', name: 'Exam', maxScore: 70 },
];
const maths = { id: 'maths', name: 'Mathematics', compulsory: true };
const english = { id: 'english', name: 'English', compulsory: true };
const french = { id: 'french', name: 'French', compulsory: false };

/** Scores for one student in one subject as [ca, exam]. */
function marks(
  studentId: string,
  subjectId: string,
  ca: number,
  exam: number,
): ComputeScore[] {
  return [
    { studentId, subjectId, componentId: 'ca', score: d(ca) },
    { studentId, subjectId, componentId: 'exam', score: d(exam) },
  ];
}

function run(
  scores: ComputeScore[],
  students = ['ada', 'bola', 'chidi'],
  subjects = [maths, english],
) {
  return computeResults({
    students: students.map((id) => ({ id })),
    subjects,
    components,
    scores,
    bands: WAEC_GRADE_BANDS,
  });
}

const student = (result: ReturnType<typeof run>, id: string) =>
  result.students.find((s) => s.studentId === id)!;

describe('computeResults', () => {
  it('totals components and grades each subject', () => {
    const result = run(
      [...marks('ada', 'maths', 25, 55), ...marks('ada', 'english', 20, 30)],
      ['ada'],
    );
    const ada = student(result, 'ada');

    expect(ada.subjects[0]).toMatchObject({
      grade: 'A1',
      remark: 'Excellent',
      isPass: true,
    });
    expect(ada.subjects[0].total.toNumber()).toBe(80);
    expect(ada.subjects[1]).toMatchObject({ grade: 'C6', isPass: true });
    expect(ada.total.toNumber()).toBe(130);
    expect(ada.average.toNumber()).toBe(65);
  });

  it('ranks the class by average, sharing tied places', () => {
    const result = run([
      ...marks('ada', 'maths', 30, 60),
      ...marks('ada', 'english', 30, 60), // 90
      ...marks('bola', 'maths', 20, 50),
      ...marks('bola', 'english', 20, 50), // 70
      ...marks('chidi', 'maths', 20, 50),
      ...marks('chidi', 'english', 20, 50), // 70
    ]);

    expect(
      ['ada', 'bola', 'chidi'].map((id) => student(result, id).position),
    ).toEqual([1, 2, 2]);
  });

  it('ranks each subject separately', () => {
    const result = run([
      ...marks('ada', 'maths', 10, 30),
      ...marks('ada', 'english', 30, 70),
      ...marks('bola', 'maths', 30, 70),
      ...marks('bola', 'english', 10, 30),
      ...marks('chidi', 'maths', 20, 50),
      ...marks('chidi', 'english', 20, 50),
    ]);

    const position = (id: string, subjectId: string) =>
      student(result, id).subjects.find((s) => s.subjectId === subjectId)!
        .position;
    expect(position('bola', 'maths')).toBe(1);
    expect(position('ada', 'maths')).toBe(3);
    expect(position('ada', 'english')).toBe(1);
  });

  it('reports class highest, lowest and average per subject', () => {
    const result = run(
      [
        ...marks('ada', 'maths', 30, 60),
        ...marks('bola', 'maths', 10, 30),
        ...marks('chidi', 'maths', 20, 45),
      ],
      ['ada', 'bola', 'chidi'],
      [maths],
    );

    const stats = result.subjectStats[0];
    expect(stats.highest.toNumber()).toBe(90);
    expect(stats.lowest.toNumber()).toBe(40);
    expect(stats.average.toNumber()).toBe(65);
    expect(stats.studentCount).toBe(3);
  });

  it('counts an elective only for the students taking it', () => {
    const result = run(
      [
        ...marks('ada', 'maths', 30, 60),
        ...marks('ada', 'french', 30, 60),
        ...marks('bola', 'maths', 30, 60),
      ],
      ['ada', 'bola'],
      [maths, french],
    );

    expect(student(result, 'ada').subjectCount).toBe(2);
    expect(student(result, 'bola').subjectCount).toBe(1);
    // Bola does not take French, so nothing is missing for her there.
    expect(result.missing).toEqual([]);
  });

  it('averages over subjects taken, so fewer electives is not a penalty', () => {
    const result = run(
      [
        ...marks('ada', 'maths', 30, 50), // 80
        ...marks('ada', 'french', 10, 30), // 40
        ...marks('bola', 'maths', 30, 50), // 80
      ],
      ['ada', 'bola'],
      [maths, french],
    );

    expect(student(result, 'ada').average.toNumber()).toBe(60);
    expect(student(result, 'bola').average.toNumber()).toBe(80);
    expect(student(result, 'bola').position).toBe(1);
  });

  it('lists missing scores and counts them as zero in the preview', () => {
    const result = run(
      [
        {
          studentId: 'ada',
          subjectId: 'maths',
          componentId: 'ca',
          score: d(25),
        },
      ],
      ['ada'],
      [maths],
    );

    expect(result.missing).toEqual([
      { studentId: 'ada', subjectId: 'maths', componentIds: ['exam'] },
    ]);
    const ada = student(result, 'ada');
    expect(ada.complete).toBe(false);
    expect(ada.subjects[0].total.toNumber()).toBe(25);
  });

  it('lists every compulsory subject a student has no scores in at all', () => {
    const result = run([], ['ada'], [maths, english]);
    expect(result.missing.map((m) => m.subjectId)).toEqual([
      'maths',
      'english',
    ]);
  });

  it('rounds an average half-up to two places', () => {
    const result = run(
      [
        ...marks('ada', 'maths', 30, 70),
        ...marks('ada', 'english', 30, 70),
        ...marks('ada', 'french', 30, 70 - 0.01),
      ],
      ['ada'],
      [maths, english, french],
    );
    // (100 + 100 + 99.99) / 3 = 99.996… → 100.00
    expect(student(result, 'ada').average.toFixed(2)).toBe('100.00');
  });

  it('leaves a student who takes nothing unranked', () => {
    const result = run(
      [...marks('ada', 'french', 30, 60)],
      ['ada', 'bola'],
      [french],
    );
    expect(student(result, 'bola').position).toBeNull();
    expect(result.rankedCount).toBe(1);
  });

  it('keeps decimals exact across many components', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
      maxScore: 10,
    }));
    const result = computeResults({
      students: [{ id: 'ada' }],
      subjects: [maths],
      components: many,
      scores: many.map((c) => ({
        studentId: 'ada',
        subjectId: 'maths',
        componentId: c.id,
        score: d('0.1'),
      })),
      bands: WAEC_GRADE_BANDS,
    });
    expect(result.students[0].subjects[0].total.toString()).toBe('1');
  });
});
