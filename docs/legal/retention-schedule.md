# EduGear Data Retention Schedule

**Version 1.0 — 22 November 2026**

Required by section 24(1)(d) of the NDP Act and paragraph 4 of the GAID's commentary on it, which
requires a **written** retention policy, communicated to data subjects.

This document is both the policy and the **specification for the code that enforces it**.

---

## 1. The rule we are applying

GAID ¶4 under s.24(1)(d):

> *Whenever it is essential to retain data solely for record purposes, a data controller or data
> processor should determine the minimum data that is relevant and necessary for the record
> purposes. Any residue of data that is not needed should be properly destroyed or irreversibly
> de-identified.*

This gives us a cleaner model than blanket deletion, and it is the one we implement:

**When a student leaves, we do not anonymise the record — we shrink it.**

A school needs to issue a transcript to a former student years later, and a transcript without a
name is useless. So the academic and financial record is **retained in full, under a lawful basis**
(s.25(1)(b)(ii), legal obligation, and the school's legitimate interest in its own records).

Everything that is *not* needed for that purpose — health data, religion, ethnicity, home address,
contact numbers, photograph, free-text notes — is **residue**, and is destroyed when the student
leaves. It has no bearing on a transcript and no reason to survive.

Two distinct operations, then, and the code implements both:

| Operation | When | Effect |
| --- | --- | --- |
| **Minimise** | A student leaves, or a guardian link ends | Destroy the surplus fields; keep the record |
| **Purge** | A school leaves EduGear, or a retention period ends | Destroy or irreversibly de-identify everything |

---

## 2. Student records

### 2.1 Minimise on departure — *runs when status becomes `GRADUATED` or `WITHDRAWN`*

| Field | Action | Why |
| --- | --- | --- |
| `firstName`, `lastName` | **Keep** | A transcript requires a name |
| `studentId` (admission no.) | **Keep** | The school's own reference for the record |
| `gender` | **Keep** | Appears on transcripts and statutory returns |
| `admissionDate`, `status` | **Keep** | Defines the period of enrolment |
| Class placement history | **Keep** | Part of the academic record |
| `middleName` | **Destroy** | Not needed for the record purpose |
| `dateOfBirth` | **Keep** | Distinguishes former students with the same name on a transcript |
| `email`, `phone`, `addressLine` | **Destroy** | Contact data serves enrolment only |
| `photoUrl` + the stored file | **Destroy** | Identification while enrolled only |
| `bloodGroup`, `genotype` | **Destroy** | Health data; consent basis ends with enrolment |
| `religion` | **Destroy** | Sensitive; never needed for a transcript |
| `stateOfOrigin`, `lga` | **Destroy** | Ethnic-origin proxy; not needed for the record |
| `nationality` | **Keep** | Appears on statutory returns |
| `notes` | **Destroy** | Free text; highest risk, lowest record value |
| Consent record for the four sensitive fields | **Destroy** | A declaration justifying data no longer held is itself surplus. The audit trail retains proof the consent existed |

**Grace period: 90 days** after status change before minimisation runs, so a withdrawal entered in
error can be reversed and a leaving certificate issued.

### 2.2 Retention of the minimised record

**Indefinite by default**, because transcript requests arrive decades later and a school that
destroyed the record cannot serve a former student. The school may instruct a shorter period.

`[TO CONFIRM with counsel: whether any Nigerian statute or state education authority sets a minimum
or maximum for school academic records. Indefinite retention of a minimised record is defensible
under s.25(1)(b)(ii) and GAID ¶4(v), but a stated statutory period is stronger.]`

### 2.3 Academic data

Scores, computed results, report cards and attendance: **retained with the student record**, on the
same basis. These are the record.

---

## 3. Guardian records

| Data | Retention | Trigger |
| --- | --- | --- |
| Name, relationship to student | Kept with the student record | — |
| Phone, alternate phone, email, address, occupation | **Destroyed 12 months** after the last linked student leaves | Last `StudentGuardian` link ends |
| Portal login (`User` account) | Deactivated when the last ward leaves; purged per §5 | Last ward leaves |

Twelve months rather than immediately: fee disputes and transcript requests surface after a student
leaves, and the school needs to reach the parent.

---

## 4. Financial records

| Data | Retention | Basis |
| --- | --- | --- |
| Invoices, fee items, payments, receipts, refunds | **7 years** from the end of the financial year | Aligns with the Companies and Allied Matters Act and FIRS record-keeping; the school's own obligation |
| Payment evidence files (uploads) | **7 years**, with the payment | Proof of the transaction |
| Payment references and provider references | **7 years** | Reconciliation against bank statements |

**Financial records are not minimised when a student leaves.** A school reconciling a bank statement
needs the name against the receipt. They are purged as a block at 7 years.

---

## 5. User and staff accounts

| Data | Retention | Trigger |
| --- | --- | --- |
| Active account | For as long as any membership is active | — |
| Dormant account | **24 months**, then name, email, phone, photograph and password destroyed; the account row is kept | No active membership at any school |

**The trigger is "no active membership anywhere", not "deactivated at one school".** One login can
hold memberships at several schools — a teacher who moves, or works at two. Acting on a single
school's deactivation would destroy the credentials they still use somewhere else, so the sweep
only touches an account that is dormant everywhere.

The row survives because audit entries reference it. Destroying it would break the audit trail,
which is itself a protection. After the sweep the entry reads as a pseudonym.

Sessions end the moment this runs: the account's token version is bumped, so any outstanding
token stops working immediately rather than at the end of its window.

A platform operator's account is never swept — it belongs to no school, so "no active membership"
is its normal state. Neither is an account linked to a guardian record.

---

## 6. Security, audit and technical data

| Data | Retention | Why |
| --- | --- | --- |
| Audit trail (`AuditLog`) | **7 years** | Evidence of who changed what; matches the financial period |
| `ipAddress`, `userAgent` on audit rows | **12 months**, then nulled; the audit entry survives | The address is only useful while an incident is live |
| Application error reports (Sentry) | **90 days** | Identifiers only — no names, emails or bodies |
| Application logs (Railway) | **30 days** (provider default) | Operational only |
| Failed sign-in counters, lockouts | Cleared on successful sign-in; **90 days** otherwise | — |
| Notifications | **24 months** | Parents refer back to fee and result notices |
| `WebhookEvent` records | **24 months** | Replay protection and payment dispute evidence |

---

## 7. Tokens and short-lived data

These are already enforced in code and need no job:

| Token | Lifetime |
| --- | --- |
| Access token | 15 minutes |
| Refresh token / session | 30 days |
| Invitation link | 72 hours |
| Email verification link | 48 hours |
| Password reset link | 60 minutes |
| Rate-limit counters | 60 seconds / 1 hour |
| Permission cache entries | 30 seconds |

Expired refresh and verification tokens are **deleted, not just marked expired**, 30 days after
expiry.

---

## 8. When a school leaves EduGear

| Stage | Period |
| --- | --- |
| Export available on request, in a structured machine-readable format | **90 days** from termination |
| Full purge of all school data, including backups on their own cycle | Within **30 days** of the export window closing, or earlier on written instruction |
| Written confirmation of deletion issued to the school | On completion |

Export is available even where fees are outstanding.

---

## 9. Erasure requests from an individual

A request is honoured under s.34(1)(d) unless s.34(2)(b) applies — there is another lawful basis to
retain.

| Request | Outcome |
| --- | --- |
| Erase the sensitive fields (genotype, blood group, religion, state of origin) | **Always honoured immediately.** Consent is the basis, so withdrawal removes it. One action erases the four values *and* the consent record, so nothing can be re-entered without fresh consent |
| Erase contact details of an enrolled student | Refused while enrolled — needed to perform the contract |
| Erase a student's whole record while enrolled | Refused; offered as withdrawal, which triggers §2.1 |
| Erase a former student's academic record | Refused under s.34(2)(b) — retained for transcripts and statutory returns. The minimisation in §2.1 has already removed everything else |
| Erase financial records | Refused for 7 years under s.34(2)(b) |
| Erase a parent portal account | Honoured; the guardian record stays per §3 |

Every refusal is given **in writing, with the specific ground**, and the person is told of their
right to complain to the Commission under s.46(1).

---

## 10. How this is enforced

All of it is implemented. [retention-policy.ts](../../src/retention/retention-policy.ts)
holds the periods above as code, and
[retention.service.ts](../../src/retention/retention.service.ts) applies them.

| # | Task | Enforces |
| --- | --- | --- |
| 1 | `students.minimise` | §2.1 |
| 2 | `guardians.minimise` | §3 |
| 3 | `audit.stripNetworkData` | §6 |
| 4 | `accounts.deidentify` | §5 |
| 5 | `notifications.purge` | §6 |
| 6 | `webhookEvents.purge` | §6 |
| 7 | `tokens.purge` | §7 |
| 8 | `audit.purge` | §6 |
| 9 | `finance.purge` | §4 |

Plus a per-school purge for §8, and a per-student export for s.34(1)(b) and
s.38 at `GET /students/:id/export`.

### Running it

```bash
npm run retention:preview              # what would be destroyed. Changes nothing.
npm run retention:run -- --execute     # do it
npm run retention:preview -- --task students.minimise
```

Or from the platform console: `POST /platform/retention/preview` for any
operator, `POST /platform/retention/run` for an OWNER only.

**Preview and run share one task list**, so what a preview reports is what a
run does — there is no second code path that could disagree. Every run writes
an audit entry naming the task and the number of records it touched.

### Why there is no scheduler

Deliberate. These jobs destroy data about children, and the first thing a new
cron would do is destroy records on a timer nobody has watched. Nothing is due
in the first ninety days of a school's life anyway, so the cost of running it
by hand is nil and the cost of getting it wrong unattended is not.

Wiring it to a schedule is a deliberate second step, taken once the preview
output has been boring for a few months. The CLI script is the thing to point a
scheduler at when that day comes.

## 11. Review

Reviewed annually, and whenever a new category of personal data is added to the schema. A new
personal-data column without an entry here is an incomplete change.

---

*A4 Technologies · EduGear · privacy@edugear.ng*
