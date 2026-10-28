import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { formatAdmissionNumber } from '../students/admission-number';
import {
  DEFAULT_SCHOOL_DAYS_MASK,
  daysFromMask,
  maskFromDays,
  normaliseMask,
} from './school-days';
import { SchoolSettingsDto, UpdateSchoolSettingsDto } from './dto/settings.dto';

export interface SchoolSettings {
  admissionNumberPrefix: string | null;
  receiptPrefix: string;
  portalEnabled: boolean;
  reminderCooldownDays: number;
  invoiceDueDays: number | null;
  reportShowPosition: boolean;
  reportShowClassStats: boolean;
  /** Seven-bit weekday mask; see school-days.ts. */
  schoolDaysMask: number;
}

/** What a school gets before it changes anything. */
export const DEFAULT_SETTINGS: SchoolSettings = {
  admissionNumberPrefix: null,
  receiptPrefix: 'RCP',
  portalEnabled: true,
  reminderCooldownDays: 7,
  invoiceDueDays: null,
  reportShowPosition: true,
  reportShowClassStats: true,
  schoolDaysMask: DEFAULT_SCHOOL_DAYS_MASK,
};

/**
 * Settings the rest of the system reads.
 *
 * A school with no row has the defaults; the row is written on the first
 * change, so nothing has to be back-filled for schools registered before this
 * existed and no read ever writes.
 *
 * Changing a setting never rewrites history: admission numbers and receipts
 * already issued keep the prefix they were issued with, and the sequence
 * continues rather than restarting.
 */
@Injectable()
export class SchoolSettingsService {
  constructor(@InjectPrisma() private readonly prisma: TenantAwarePrisma) {}

  async current(): Promise<SchoolSettings> {
    const row = await this.prisma.schoolSettings.findFirst();
    return row ? this.fromRow(row) : { ...DEFAULT_SETTINGS };
  }

  async view(): Promise<SchoolSettingsDto> {
    const { schoolDaysMask, ...settings } = await this.current();
    return {
      ...settings,
      // The mask is how the row stores it; the API speaks in day names.
      schoolDays: daysFromMask(schoolDaysMask),
      admissionNumberExample: formatAdmissionNumber(
        new Date().getUTCFullYear(),
        1,
        settings.admissionNumberPrefix,
      ),
    };
  }

  async update(
    dto: UpdateSchoolSettingsDto,
    schoolId: string,
  ): Promise<{ settings: SchoolSettingsDto; changed: string[] }> {
    const before = await this.current();
    const merged: SchoolSettings = {
      ...before,
      ...(dto.admissionNumberPrefix !== undefined
        ? { admissionNumberPrefix: dto.admissionNumberPrefix }
        : {}),
      ...(dto.receiptPrefix !== undefined
        ? { receiptPrefix: dto.receiptPrefix }
        : {}),
      ...(dto.portalEnabled !== undefined
        ? { portalEnabled: dto.portalEnabled }
        : {}),
      ...(dto.reminderCooldownDays !== undefined
        ? { reminderCooldownDays: dto.reminderCooldownDays }
        : {}),
      ...(dto.invoiceDueDays !== undefined
        ? { invoiceDueDays: dto.invoiceDueDays }
        : {}),
      ...(dto.reportShowPosition !== undefined
        ? { reportShowPosition: dto.reportShowPosition }
        : {}),
      ...(dto.reportShowClassStats !== undefined
        ? { reportShowClassStats: dto.reportShowClassStats }
        : {}),
      ...(dto.schoolDays !== undefined
        ? { schoolDaysMask: maskFromDays(dto.schoolDays) }
        : {}),
    };

    await this.prisma.schoolSettings.upsert({
      where: { schoolId },
      create: { schoolId, ...merged },
      update: merged,
    });

    const changed = (Object.keys(merged) as (keyof SchoolSettings)[])
      .filter((key) => merged[key] !== before[key])
      // The audit trail is read by people, so it names the field they changed
      // rather than the column it happens to be stored in.
      .map((key) => (key === 'schoolDaysMask' ? 'schoolDays' : key));

    return { settings: await this.view(), changed };
  }

  /** Portal routes call this; a disabled portal is closed to every parent. */
  async assertPortalEnabled(): Promise<void> {
    const { portalEnabled } = await this.current();
    if (!portalEnabled) {
      throw AppException.forbidden(
        'The parent portal is currently switched off by the school',
      );
    }
  }

  /** The due date an invoice gets when its fee structure sets none. */
  async defaultDueDate(): Promise<Date | null> {
    const { invoiceDueDays } = await this.current();
    if (invoiceDueDays === null) return null;

    const due = new Date();
    due.setUTCDate(due.getUTCDate() + invoiceDueDays);
    return new Date(
      Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()),
    );
  }

  private fromRow(row: SchoolSettings): SchoolSettings {
    return {
      admissionNumberPrefix: row.admissionNumberPrefix,
      receiptPrefix: row.receiptPrefix,
      portalEnabled: row.portalEnabled,
      reminderCooldownDays: row.reminderCooldownDays,
      invoiceDueDays: row.invoiceDueDays,
      reportShowPosition: row.reportShowPosition,
      reportShowClassStats: row.reportShowClassStats,
      // Normalised on read so a row written before this column existed, or one
      // edited by hand, still describes a week the school can open in.
      schoolDaysMask: normaliseMask(row.schoolDaysMask),
    };
  }
}
