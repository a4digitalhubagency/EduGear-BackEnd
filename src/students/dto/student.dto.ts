import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ConsentMethod,
  Gender,
  GuardianRelationship,
  StudentStatus,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { NG_PHONE_REGEX } from '../../tenants/dto/school.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A parent's consent to the sensitive fields, as the school recorded it.
 *
 * Sent alongside the fields themselves rather than through a separate call, so
 * the tick-box and the values it authorises arrive in one request and cannot
 * half-succeed. A payload that sets genotype without this block is refused.
 */
export class SensitiveDataConsentDto {
  @ApiProperty({
    example: 'Mrs Chinwe Obi',
    description:
      'The parent or guardian who gave consent, as named on the form. ' +
      'Recorded because section 26(2) puts the burden of demonstrating ' +
      'consent on the school, and a date with no name behind it does not ' +
      'discharge it.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  givenBy: string;

  @ApiProperty({
    enum: ConsentMethod,
    description: 'How it was obtained. Every value names a documented act.',
  })
  @IsEnum(ConsentMethod)
  method: ConsentMethod;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'When the parent gave it — the date on the admission form, which may ' +
      'predate the record being entered. Defaults to now. Never in the future.',
  })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  givenAt?: Date;
}

/** Fields a student shares between admission and update. */
class StudentProfileFields {
  @ApiPropertyOptional({ example: 'Ada' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Obi' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(80)
  @IsOptional()
  middleName?: string | null;

  @ApiPropertyOptional({ enum: Gender })
  @IsEnum(Gender)
  @IsOptional()
  gender?: Gender;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @ValidateIf((_, value) => value !== null)
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  dateOfBirth?: Date | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  @MaxLength(180)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ example: '08031234567', nullable: true })
  @ValidateIf((_, value) => value !== null)
  @Matches(NG_PHONE_REGEX, {
    message: 'phone must be a valid Nigerian phone number',
  })
  @IsOptional()
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  addressLine?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  photoUrl?: string | null;

  @ApiPropertyOptional({ example: 'O+', nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(10)
  @IsOptional()
  bloodGroup?: string | null;

  @ApiPropertyOptional({ example: 'AA', nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(10)
  @IsOptional()
  genotype?: string | null;

  @ApiPropertyOptional({ example: 'Oyo', nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(80)
  @IsOptional()
  stateOfOrigin?: string | null;

  @ApiPropertyOptional({ example: 'Ibadan North', nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(80)
  @IsOptional()
  lga?: string | null;

  @ApiPropertyOptional({ default: 'Nigerian' })
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  @IsOptional()
  nationality?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(80)
  @IsOptional()
  religion?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  notes?: string | null;

  @ApiPropertyOptional({
    type: () => SensitiveDataConsentDto,
    description:
      'Required when this request sets genotype, blood group, religion, ' +
      'state of origin or LGA and no consent is already on record. Omit it ' +
      'when those fields are untouched, or when consent was recorded ' +
      'earlier. Sending it again replaces the record — which is how a ' +
      'school corrects a mistyped name or a re-signed form.',
  })
  @ValidateNested()
  @Type(() => SensitiveDataConsentDto)
  @IsOptional()
  sensitiveDataConsent?: SensitiveDataConsentDto;
}

export class AdmitStudentDto extends StudentProfileFields {
  @ApiProperty({ example: 'Ada' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  declare firstName: string;

  @ApiProperty({ example: 'Obi' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  declare lastName: string;

  @ApiProperty({ enum: Gender })
  @IsEnum(Gender)
  declare gender: Gender;

  @ApiProperty({ example: '2025-09-15', type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  admissionDate: Date;

  @ApiPropertyOptional({
    example: '2025/0001',
    description: 'Admission number. Generated per school when omitted.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @IsOptional()
  studentId?: string;

  @ApiPropertyOptional({ description: 'Arm to place the student in' })
  @IsUUID()
  @IsOptional()
  classArmId?: string;
}

/**
 * `studentId` and `status` are absent by design: an admission number is an
 * identity, and status moves through its own endpoint so the change is audited
 * as a status change rather than a field edit.
 */
export class UpdateStudentDto extends StudentProfileFields {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Pass null to unassign the student from their arm',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  @IsOptional()
  classArmId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  admissionDate?: Date;
}

export class ChangeStudentStatusDto {
  @ApiProperty({ enum: StudentStatus })
  @IsEnum(StudentStatus)
  status: StudentStatus;

  @ApiPropertyOptional({ description: 'Recorded on the audit entry' })
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  reason?: string;
}

const SORTABLE = [
  'lastName',
  'firstName',
  'studentId',
  'admissionDate',
  'createdAt',
] as const;

export class QueryStudentsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: StudentStatus,
    description: 'Defaults to ACTIVE; pass ALL to include every status',
  })
  @IsIn([...Object.values(StudentStatus), 'ALL'])
  @IsOptional()
  status?: StudentStatus | 'ALL';

  @ApiPropertyOptional() @IsUUID() @IsOptional() classArmId?: string;

  @ApiPropertyOptional({ description: 'Every arm of this class' })
  @IsUUID()
  @IsOptional()
  classId?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsEnum(Gender)
  @IsOptional()
  gender?: Gender;

  @ApiPropertyOptional({ description: 'Students with no arm assigned' })
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  @IsOptional()
  unassigned?: boolean;

  @ApiPropertyOptional({
    description:
      'Students who hold at least one sensitive field with no parental ' +
      'consent on record. Every record migrated from paper starts in that ' +
      'state, so this is the school’s working list for collecting it.',
  })
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  @IsOptional()
  sensitiveConsentMissing?: boolean;

  @ApiPropertyOptional({ enum: SORTABLE, default: 'lastName' })
  @IsIn(SORTABLE)
  @IsOptional()
  sortBy: (typeof SORTABLE)[number] = 'lastName';
}

export class StudentGuardianSummaryDto {
  @ApiProperty() guardianId: string;
  @ApiProperty() fullName: string;
  @ApiProperty() phone: string;
  @ApiPropertyOptional({ nullable: true }) email: string | null;
  @ApiProperty({ enum: GuardianRelationship })
  relationship: GuardianRelationship;
  @ApiProperty() isPrimary: boolean;
  @ApiProperty() canPickUp: boolean;
}

/**
 * The consent behind the sensitive fields, as held.
 *
 * Read by the frontend to decide whether the tick-box shows as already given,
 * refused, or never asked — three states a single boolean could not carry.
 */
export class SensitiveDataConsentRecordDto {
  @ApiProperty({ type: String, format: 'date-time' })
  givenAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Null on a record migrated under a batch declaration',
  })
  givenBy: string | null;

  @ApiPropertyOptional({ enum: ConsentMethod, nullable: true })
  method: ConsentMethod | null;
}

export class StudentDto {
  @ApiProperty() id: string;
  @ApiProperty() studentId: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiPropertyOptional({ nullable: true }) middleName: string | null;
  @ApiProperty({ description: '"Obi, Ada N." — list display' })
  fullName: string;
  @ApiProperty({ enum: Gender }) gender: Gender;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date' })
  dateOfBirth: Date | null;
  @ApiPropertyOptional({ nullable: true }) email: string | null;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiPropertyOptional({ nullable: true }) addressLine: string | null;
  @ApiPropertyOptional({ nullable: true }) photoUrl: string | null;
  @ApiProperty({ type: String, format: 'date' }) admissionDate: Date;
  @ApiProperty({ enum: StudentStatus }) status: StudentStatus;
  @ApiPropertyOptional({ nullable: true }) classArmId: string | null;
  @ApiPropertyOptional({ nullable: true, description: '"JSS1 A"' })
  className: string | null;
  @ApiPropertyOptional({ nullable: true }) bloodGroup: string | null;
  @ApiPropertyOptional({ nullable: true }) genotype: string | null;
  @ApiPropertyOptional({ nullable: true }) stateOfOrigin: string | null;
  @ApiPropertyOptional({ nullable: true }) lga: string | null;
  @ApiProperty() nationality: string;
  @ApiPropertyOptional({ nullable: true }) religion: string | null;
  @ApiPropertyOptional({ nullable: true }) notes: string | null;

  @ApiPropertyOptional({
    type: () => SensitiveDataConsentRecordDto,
    nullable: true,
    description:
      'The parental consent behind the sensitive fields above. Null when ' +
      'none is on record — in which case those fields cannot be written.',
  })
  sensitiveDataConsent: SensitiveDataConsentRecordDto | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Set when a parent withdrew consent. Distinguishes “they said no” ' +
      'from “nobody has asked yet”, which both leave the fields empty.',
  })
  sensitiveDataConsentWithdrawnAt: Date | null;

  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

/** The full profile — everything in StudentDto plus the guardians. */
/**
 * The outcome of erasing a student's sensitive personal data.
 *
 * Names the fields that were cleared, never the values they held — writing the
 * values into an audit entry that outlives the record would defeat the erasure.
 */
export class SensitiveDataErasureDto {
  @ApiProperty({ type: () => StudentDto })
  student: StudentDto;

  @ApiProperty({
    isArray: true,
    type: String,
    example: ['genotype', 'religion'],
    description:
      'Fields that held a value and were erased. Empty when there was ' +
      'nothing to erase — the request still succeeds.',
  })
  erasedFields: string[];

  @ApiProperty({
    description:
      'True when a consent record was on file and has been withdrawn. ' +
      'Erasing the values without dropping the record would leave the ' +
      'school claiming a basis for data it no longer holds.',
  })
  consentWithdrawn: boolean;
}

export class StudentProfileDto extends StudentDto {
  @ApiProperty({ type: [StudentGuardianSummaryDto] })
  guardians: StudentGuardianSummaryDto[];
}
