import { Prisma } from '@prisma/client';
import {
  DEFAULT_ASSESSMENT_COMPONENTS,
  WAEC_GRADE_BANDS,
  gradeFor,
  validateAssessmentScheme,
  validateGradeBands,
} from './grading';

const d = (value: number | string) => new Prisma.Decimal(value);

describe('validateGradeBands', () => {
  it('accepts the WAEC scale', () => {
    expect(validateGradeBands(WAEC_GRADE_BANDS)).toEqual([]);
  });

  it('accepts bands in any order', () => {
    expect(validateGradeBands([...WAEC_GRADE_BANDS].reverse())).toEqual([]);
  });

  it('finds a gap', () => {
    const bands = WAEC_GRADE_BANDS.filter((band) => band.grade !== 'C5');
    expect(validateGradeBands(bands)).toEqual([
      'Nothing covers 55–59, between C6 and C4',
    ]);
  });

  it('finds an overlap', () => {
    const bands = WAEC_GRADE_BANDS.map((band) =>
      band.grade === 'B2' ? { ...band, minScore: 69 } : band,
    );
    expect(validateGradeBands(bands)).toEqual(['Grades B3 and B2 overlap']);
  });

  it('insists on covering 0 and 100', () => {
    expect(
      validateGradeBands([
        {
          grade: 'P',
          minScore: 40,
          maxScore: 90,
          remark: 'Pass',
          isPass: true,
        },
      ]),
    ).toEqual(['Nothing covers 0–39', 'Nothing covers 91–100']);
  });

  it('refuses repeated grades and fractional marks', () => {
    expect(
      validateGradeBands([
        { grade: 'A', minScore: 0, maxScore: 49.5, remark: '', isPass: false },
        { grade: 'a', minScore: 50, maxScore: 100, remark: '', isPass: true },
      ]),
    ).toEqual(['Grade A must use whole marks', 'Grade a appears twice']);
  });
});

describe('gradeFor', () => {
  it.each([
    [100, 'A1'],
    [75, 'A1'],
    [74, 'B2'],
    [50, 'C6'],
    [40, 'E8'],
    [39, 'F9'],
    [0, 'F9'],
  ])('%p → %p', (total, grade) => {
    expect(gradeFor(d(total), WAEC_GRADE_BANDS)?.grade).toBe(grade);
  });

  it('never rounds a total up into a better grade', () => {
    expect(gradeFor(d('74.5'), WAEC_GRADE_BANDS)?.grade).toBe('B2');
    expect(gradeFor(d('39.99'), WAEC_GRADE_BANDS)?.grade).toBe('F9');
  });
});

describe('validateAssessmentScheme', () => {
  it('accepts the default 3 CA + exam split', () => {
    expect(validateAssessmentScheme(DEFAULT_ASSESSMENT_COMPONENTS)).toEqual([]);
  });

  it('insists on 100 marks', () => {
    expect(
      validateAssessmentScheme([
        { name: 'CA', maxScore: 30 },
        { name: 'Exam', maxScore: 60 },
      ]),
    ).toEqual([
      'The components add up to 90; they must add up to 100 so every total is a percentage',
    ]);
  });

  it('refuses a repeated name', () => {
    expect(
      validateAssessmentScheme([
        { name: 'CA', maxScore: 40 },
        { name: 'ca', maxScore: 60 },
      ]),
    ).toEqual(['"ca" appears twice']);
  });

  it('refuses a component worth nothing', () => {
    expect(
      validateAssessmentScheme([
        { name: 'CA', maxScore: 0 },
        { name: 'Exam', maxScore: 100 },
      ]),
    ).toEqual(['"CA" must be worth a whole number of marks']);
  });
});
