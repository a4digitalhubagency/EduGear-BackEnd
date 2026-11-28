# EduGear Privacy Policy

**Last updated: 22 November 2026**

This policy explains what personal data EduGear handles, why, and what you can do about it.
It is written to meet section 27 of the Nigeria Data Protection Act 2023 ("the NDP Act").

EduGear is operated by **A4 Technologies** ("we", "us").

- **Address:** `[fill in before publishing]`
- **RC number:** `[fill in before publishing]`
- **Contact for everything, including data protection:** edugearsupport@gmail.com

---

## 1. Who controls your data — this matters

EduGear handles personal data in **two different roles**, and your rights are exercised in
different places depending on which applies.

### Your school is the controller; we are its processor

For everything about students, guardians and school staff — names, class records, results,
attendance, fee records — **your school decides what is collected and why.** We hold and process
it on the school's instructions, under a written agreement with them. We do not use it for our own
purposes, we do not sell it, and we do not use it to train artificial-intelligence models.

**If you are a parent or a student, address requests about this data to your school first.** They
hold the relationship with you and the authority to act on it. We will support them in answering.

### We are the controller of account and service data

We decide the purposes for a narrower set of data: the login credentials and session records of
everyone who uses EduGear, the contact and billing details of the school as our customer, and the
technical logs we keep to run and secure the service. For that data, you can come to us directly.

---

## 2. What we handle

### Student records (school is controller)

Name, admission number, gender, date of birth, photograph, contact details and address,
nationality, admission date, class placement, and free-text notes recorded by the school.

Academic and attendance data: subject scores, assessment results, computed grades and positions,
report cards, and daily attendance registers.

Financial data: invoices raised, fee items, payments recorded, receipt numbers, payment evidence
uploaded by a parent or the school, and refund records.

### Sensitive personal data

Some student fields fall within **section 30 of the NDP Act**, which sets a higher bar:

| Field | Category under section 65 |
| --- | --- |
| Genotype | Genetic data / health status |
| Blood group | Health status |
| Religion | Religious or similar beliefs |
| State of origin, LGA | Race or ethnic origin |

**These fields are optional, and they cannot be filled in without your consent.** Section 30 does
not contain the exemption for education that section 31 provides, so the lawful basis for them is
the **consent of the parent or legal guardian** under sections 30(1)(a) and 31(1), obtained by the
school.

Section 26(2) puts the burden of *demonstrating* that consent on the school, so EduGear does not
take it on trust. Each student record stores **who gave consent, how it was obtained and on what
date** — the box on the school's admission form, or a separate signed consent form. **Until that
record exists, the system refuses to store any of these four fields.** It is not a warning that can be clicked past; the data is rejected.

A school importing records from paper declares, once per file, that the consent forms are on file
for the students in it. That declaration is recorded against every record it covers and appears in
the school's audit trail. Where a school's existing records already hold these fields without a
consent record, the school can list exactly which students those are and go and collect it.

**You can withdraw consent at any time** by asking your school, and they can do it in one action —
the same route by which it was given, as section 35(2) requires. (Consent is collected and
withdrawn through the school, not in the parent portal, because the school is the controller of
this data and holds the relationship with you.) Withdrawing erases
all four fields immediately, drops the consent record, and leaves the rest of the record untouched —
your child's name, class, results and fees are held on a different basis and are not affected.
Nothing can be re-entered afterwards without fresh consent.

### Guardian and parent records (school is controller)

Name, relationship to the student, phone numbers, email address, home address and occupation,
together with the portal login if the guardian has claimed one.

### Staff and user accounts (we are controller)

Name, email address, phone number, password — stored only as an irreversible argon2 hash, never in
readable form — profile photograph, role and permissions at the school, and the status of the
account.

### Technical and security data (we are controller)

Sign-in times and failed sign-in attempts, IP address and browser user-agent recorded against
sign-ins and significant actions, an audit trail of who changed what and when, and application
error reports.

Our error reports are deliberately stripped: they carry identifiers such as a request id, school id
and user id, and **never names, email addresses, request bodies or log text.**

---

## 3. Why, and on what lawful basis

| What we do | Lawful basis (NDP Act) |
| --- | --- |
| Run the school's records, fees, results and attendance | s.25(1)(b)(i) — performance of a contract |
| Keep records a school is legally required to keep | s.25(1)(b)(ii) — legal obligation |
| Authenticate users, prevent abuse, keep the service secure | s.25(1)(b)(v) — legitimate interests |
| Keep an audit trail and investigate incidents | s.25(1)(b)(v) — legitimate interests |
| Bill the school and collect subscription fees | s.25(1)(b)(i) — performance of a contract |
| Record genotype, blood group, religion, state of origin | s.30(1)(a) — consent, given by a parent or guardian under s.31(1), recorded per student as s.26(2) requires |
| Send a parent notices about their own child's fees and results | s.25(1)(b)(i) — performance of a contract |

We do **not** rely on consent for ordinary school records. Processing carried out for the purposes
of education by a provider owing a duty of confidentiality is exempt from the parental-consent
requirement under **section 31(4)(b)**. This is deliberate: a basis that could be withdrawn
mid-term would destroy a student's academic record part-way through a school year.

We do not use personal data for advertising, and we do not sell or rent it to anyone.

---

## 4. Automated decision-making

**We do not make decisions about anyone by automated means alone.**

EduGear computes results — totals, grades against the school's grade bands, and class positions.
That computation is a draft. **A member of staff reviews, approves and publishes it**, and can
correct any score before it reaches a parent. No grade, no fee and no account decision takes effect
without a person deciding it. This satisfies the safeguards in section 37(3).

---

## 5. Who we share it with

We share student, guardian and staff data only with **the school it belongs to**. Each school's
data is isolated from every other school's at the database level.

We use the following service providers ("sub-processors"), each under contract and each permitted
to process data only as needed to provide their service:

| Provider | What they do | Where |
| --- | --- | --- |
| Neon | Hosts the database | Outside Nigeria |
| Railway | Runs the application servers | Outside Nigeria |
| Cloudflare R2 | Stores uploaded photographs and payment evidence | Distributed |
| Paystack | Processes online card and transfer payments | Nigeria |
| Resend | Sends transactional email | United States |
| Sentry | Receives application error reports | United States |

We will give schools notice before adding or replacing a sub-processor.

We may also disclose data where we are required to by law, by a court, or by the Nigeria Data
Protection Commission.

---

## 6. Transfers outside Nigeria

**Some of the providers above are outside Nigeria, and that means your data is too.**

The Commission has not yet published a list of countries it considers adequate — the GAID 2025
says Schedule 5 applies pending a regulatory instrument on the subject. We therefore rely on
**section 41(1)(a)**: each provider is bound by contractual clauses requiring a level of protection
consistent with the NDP Act. We keep a written record of the basis for each transfer and our
assessment of its adequacy, as section 41(2) requires.

Payments are processed by Paystack **in Nigeria**. Card details never reach EduGear's systems: you
enter them with Paystack directly, and we receive only a reference, a status and an amount.

---

## 7. How long we keep it

Our full schedule is published separately as the **EduGear Data Retention Schedule**. In summary:

**When a student leaves, we shrink the record rather than keep all of it.** Within 90 days of a
student graduating or withdrawing, we destroy everything not needed to issue a transcript — home
address, phone numbers, photograph, free-text notes, and the sensitive fields in section 2:
genotype, blood group, religion and state of origin. The academic record itself is kept, because a
former student may need a transcript years later and one without a name is useless.

| Data | Kept for |
| --- | --- |
| Academic record of a former student | Indefinitely, unless the school instructs otherwise — this is what a transcript is issued from |
| Contact details, photograph, notes, sensitive fields | Destroyed 90 days after a student leaves |
| Consent record behind the sensitive fields | Destroyed with them — the audit trail keeps proof it existed |
| Guardian contact details | 12 months after the last linked student leaves |
| Invoices, payments, receipts and payment evidence | 7 years from the end of the financial year |
| Audit trail | 7 years |
| IP address and browser recorded against an action | 12 months, then removed from the entry |
| Error reports | 90 days |
| Notifications | 24 months |
| Staff account with no active role at any school | 24 months, then name, email, phone, photo and password destroyed |
| Sign-in sessions | 30 days from issue |
| Invitation links | 72 hours |
| Email verification links | 48 hours |
| Password reset links | 60 minutes |
| Everything, after a school leaves EduGear | Available to export for 90 days, then deleted within a further 30 days |

Where a record must be kept past these periods because the law requires it, we keep **only that
record, only for that reason**, and it stays protected by this policy.

---

## 8. Your rights

Under Part VI of the NDP Act you have the right to:

- **know** whether we hold data about you, and to be told what it is and who has seen it (s.34(1)(a));
- **get a copy** of it in a commonly used electronic format (s.34(1)(b));
- **have it corrected** where it is wrong, out of date or misleading (s.34(1)(c));
- **have it erased**, without undue delay (s.34(1)(d));
- **restrict** what we do with it while a request or objection is being resolved (s.34(1)(e));
- **object** to processing based on our legitimate interests (s.36);
- **withdraw consent** where consent is the basis — which applies to the sensitive fields in
  section 2 above — as easily as it was given (s.35), in one action, with the fields erased
  immediately;
- **not be subject** to a decision made by automated means alone (s.37).

**Erasure is not always absolute.** Where a school has an independent legal obligation to keep a
record, section 34(2)(b) allows it to be retained — but only that record, and only for that reason.
Everything beyond it is erased or de-identified.

**How to exercise them.** If the data belongs to a school, ask the school. For account data we
control, email **edugearsupport@gmail.com**. We respond without undue delay and in any case within
30 days. There is no charge, unless providing a copy would impose unreasonable cost, in which case
we will tell you before doing anything.

---

## 9. Complaints

If you are unhappy with how your data has been handled, please tell us first at
**edugearsupport@gmail.com** — most things are quicker to fix directly.

You also have the right, under **section 46(1) of the NDP Act**, to complain to:

> **Nigeria Data Protection Commission**
> https://ndpc.gov.ng

and to seek redress in the Federal or State High Court nearest to you.

---

## 10. How we protect it

- Every school's data is **isolated at the database layer**. The isolation fails closed: a query
  that cannot establish which school it belongs to is refused rather than answered.
- Passwords are stored as **argon2 hashes** and are never recoverable, by us or anyone else.
- Access is **permission-based**. Staff see only what their role allows, and a teacher can only
  enter scores for subjects and classes they are assigned to.
- Changing someone's role, suspending them or a password change **ends their existing sessions.**
- The sensitive fields in section 2 **cannot be written without a stored consent record**, and
  withdrawing consent erases them in the same operation that drops the record.
- Every significant change is written to an **audit trail** naming who made it and when.
- All traffic is encrypted in transit.
- Uploads are checked by **reading the file's actual bytes**, not by trusting what it claims to be.
- Error reports are stripped of names, emails and message content before they leave our systems.

No system is perfectly secure, and we do not claim otherwise.

---

## 11. If something goes wrong

If a breach occurs that is likely to put your rights at risk, we will notify the Nigeria Data
Protection Commission **within 72 hours** of becoming aware of it, as section 40(2) requires, and
tell affected people **immediately** where the risk is high. Where we are processing on a school's
behalf, we notify the school at once so they can meet their own obligation.

---

## 12. Children

EduGear exists to keep records about children, and we treat that seriously. Children's data is
handled on the instruction of the school, for educational purposes, under section 31(4)(b).

We do not market to children, we do not profile them, and we do not use their data for anything
beyond the school's own administration. A child's record is visible only to authorised staff at
their own school and to the guardians linked to that child — a parent cannot see another family's
child.

---

## 13. Changes

We will post any change here and update the date at the top. If a change materially affects your
rights, we will tell schools directly before it takes effect.

---

*A4 Technologies · EduGear · edugearsupport@gmail.com*
