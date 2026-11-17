import { Injectable, Logger } from '@nestjs/common';
import { AUDIT_ACTIONS } from '../../audit/audit-actions';
import { AuditService } from '../../audit/audit.service';
import { AppException } from '../../common/errors/app.exception';
import { InjectPrisma } from '../../database/prisma.tokens';
import { TenantAwarePrisma } from '../../database/prisma.service';
import { PaystackBank, PaystackClient } from './paystack.client';
import {
  lastFour,
  maskAccountNumber,
  normaliseAccountNumber,
  PLATFORM_PERCENTAGE_CHARGE,
} from './settlement';
import {
  ResolveAccountDto,
  ResolvedAccountDto,
  SettlementAccountDto,
  SetSettlementAccountDto,
} from './dto/settlement.dto';

/**
 * A school's own bank account, as Paystack knows it.
 *
 * The proprietor enters it themselves: EduGear does not collect or key in
 * bank details on a school's behalf. That is deliberate — it is somebody
 * else's money, keying it in makes us responsible for a digit we mistyped,
 * and it does not scale past the first few schools.
 *
 * Nothing here is visible to the platform console. A4 can see *whether* a
 * school has configured settlement, because that decides whether the school
 * can take cards at all; it cannot see the account. The console is
 * metadata-only and sees no money, and a bank account is exactly the kind of
 * thing that rule exists for.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly client: PaystackClient,
    private readonly audit: AuditService,
  ) {}

  /** Populates the bank picker. */
  async banks(): Promise<PaystackBank[]> {
    this.assertConfigured();
    return this.client.listBanks();
  }

  /**
   * Asks the bank who owns the account, so the school confirms a name rather
   * than trusting the digits it just typed. A transposed digit that happens to
   * be a real account is otherwise discovered when someone else receives a
   * term's fees.
   *
   * Reads only. Nothing is stored until the school comes back and saves.
   */
  async resolve(dto: ResolveAccountDto): Promise<ResolvedAccountDto> {
    this.assertConfigured();

    const accountNumber = this.assertAccountNumber(dto.accountNumber);
    const resolved = await this.client.resolveAccount(
      accountNumber,
      dto.bankCode,
    );

    return {
      accountName: resolved.accountName,
      accountNumberMasked: maskAccountNumber(lastFour(accountNumber)),
    };
  }

  async current(): Promise<SettlementAccountDto> {
    const school = await this.prisma.school.findFirstOrThrow({
      select: {
        paystackSubaccountCode: true,
        settlementBankName: true,
        settlementAccountName: true,
        settlementAccountLast4: true,
      },
    });

    return {
      configured: Boolean(school.paystackSubaccountCode),
      bankName: school.settlementBankName,
      accountName: school.settlementAccountName,
      accountNumberMasked: school.settlementAccountLast4
        ? maskAccountNumber(school.settlementAccountLast4)
        : null,
    };
  }

  /**
   * Creates the subaccount, or points an existing one at a different bank
   * account. Either way the school keeps one subaccount: a second would leave
   * payments already in flight settling somewhere the school has stopped
   * watching.
   */
  async set(
    dto: SetSettlementAccountDto,
    schoolId: string,
  ): Promise<SettlementAccountDto> {
    this.assertConfigured();

    const accountNumber = this.assertAccountNumber(dto.accountNumber);
    const school = await this.prisma.school.findFirstOrThrow({
      select: { name: true, paystackSubaccountCode: true },
    });

    // Resolved again rather than trusting what the screen sent back: the
    // confirmation step and the save are separate requests, and only this one
    // decides where money goes.
    const bank = await this.findBank(dto.bankCode);
    const resolved = await this.client.resolveAccount(
      accountNumber,
      dto.bankCode,
    );

    const params = {
      businessName: school.name,
      bankCode: dto.bankCode,
      accountNumber,
      // Zero: EduGear sells a subscription and takes nothing from tuition.
      percentageCharge: PLATFORM_PERCENTAGE_CHARGE,
    };

    const subaccountCode = school.paystackSubaccountCode
      ? await this.client
          .updateSubaccount(school.paystackSubaccountCode, params)
          .then(() => school.paystackSubaccountCode as string)
      : await this.client.createSubaccount(params);

    await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        paystackSubaccountCode: subaccountCode,
        settlementBankCode: dto.bankCode,
        settlementBankName: bank.name,
        settlementAccountName: resolved.accountName,
        // The number itself stays with Paystack; a subaccount is updated by
        // its code, so nothing here needs to read it back.
        settlementAccountLast4: lastFour(accountNumber),
      },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.SCHOOL_SETTLEMENT_UPDATED,
      entityType: 'School',
      entityId: schoolId,
      description: `Fees now settle to ${resolved.accountName} at ${bank.name} (${maskAccountNumber(lastFour(accountNumber))})`,
      metadata: {
        bankCode: dto.bankCode,
        bankName: bank.name,
        accountLast4: lastFour(accountNumber),
      },
    });

    return this.current();
  }

  // ---------------------------------------------------------------------------

  private assertConfigured(): void {
    if (!this.client.configured) {
      throw AppException.conflict(
        'Online payments are not configured for this deployment',
      );
    }
  }

  private assertAccountNumber(value: string): string {
    const accountNumber = normaliseAccountNumber(value);
    if (!accountNumber) {
      throw AppException.badRequest('A Nigerian account number is ten digits');
    }
    return accountNumber;
  }

  /**
   * The bank has to be one Paystack settles to, and we want its name for the
   * record — a code on its own tells a bursar nothing when they come back in
   * a year to check where fees are going.
   */
  private async findBank(bankCode: string): Promise<PaystackBank> {
    const banks = await this.client.listBanks();
    const bank = banks.find((candidate) => candidate.code === bankCode);
    if (!bank) {
      throw AppException.badRequest(
        'That bank is not one Paystack can settle to',
      );
    }
    return bank;
  }
}
