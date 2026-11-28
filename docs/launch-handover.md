# What is left before a school can use EduGear

Written for **Ahmad** (the technical items) and **Adewale** (the commercial and
legal ones). Everything is split by who can actually do it.

The backend is finished and deployed. Both environments run the current code,
the Railway configuration is entered by hand and proven, and every check that
can be run from outside passes. What remains is three kinds of thing: one
functional gap, some security hygiene, and the paperwork that gates a
signature rather than usage.

## How to check anything in here

```bash
npm run verify:deploy -- https://api.edugear.ng production https://www.edugear.ng
npm run verify:deploy -- https://edugear-backend-staging.up.railway.app staging
```

Eleven checks, read-only, no credentials. It asks the running service what it
believes rather than reading a dashboard back, which is the distinction that
matters: a dashboard showing the right value is not evidence the value is in
force.

---

# 1. Email does not send — *Ahmad* — **blocking**

Nothing else on this list stops a school working. This does.

Without it a school cannot invite staff, parents cannot reach the portal, and
nobody can reset a password. It is also **silent**: a failed send does not fail
the request that triggered it, so the school sees "invited" and the parent
receives nothing at all.

It is worse than it sounds, because inviting parents now requires the inviting
account's own address to have been verified, and that verification arrives by
email. With sending broken, the failure surfaces as a permissions error with no
obvious cause.

### What happened

The Resend account moved from A4's to the one under `edugearsupport@gmail.com`.
The DNS records currently published were issued by the **old** account, so the
new one does not recognise the domain and rejects every send.

### What to do

1. Sign in to Resend as `edugearsupport@gmail.com` → **Domains** → add
   `edugear.ng`.
2. Resend will issue records. The DKIM value **will be different** from the one
   currently in DNS.
3. In the DNS provider, **replace** `resend._domainkey.edugear.ng` with the new
   value. Do not add a second record on that name — two DKIM records on one
   selector break both. SPF and the bounce MX on `send.edugear.ng` are likely
   unchanged; match them to whatever Resend shows.
4. If the domain is still attached to the old A4 account, remove it there first
   so the selector is free.
5. Click **Verify DNS Records**. DNS propagation is usually minutes.
6. Create an API key **on this account** and set it as `RESEND_API_KEY` in
   Railway → production → Variables. A key from the old account will not work
   even once the domain verifies.
7. Redeploy.

### How you know it worked

```bash
curl -s -X POST https://api.edugear.ng/api/auth/register-school \
  -H 'Content-Type: application/json' \
  -d '{
    "schoolName":"Email Test School",
    "schoolEmail":"edugearsupport+testschool@gmail.com",
    "firstName":"Test","lastName":"Owner",
    "email":"edugearsupport+testowner@gmail.com",
    "password":"Kalabari-Mangrove-77!",
    "phone":"08031234567"
  }'
```

A `201` means the school was created. Then check `edugearsupport@gmail.com` —
the `+` alias delivers to the same inbox — for a message containing
`verify-email?token=`. **Check spam**: a newly verified sending domain often
lands there on its first message.

Resend's **Emails** tab is the tiebreaker. An entry for that address means the
send left your side. No entry means the application never reached Resend, which
points back at the API key.

### Then remove the test school

Log in to the platform console as `edugearsupport@gmail.com`, find the school,
and **purge** it. Cancelling marks it cancelled and keeps the row; purging
deletes it, and asks for the school's exact name plus a confirmation field
precisely because it cannot be undone.

---

# 2. Security hygiene — *Ahmad* — **today**

### Rotate the Neon database password

The `neondb_owner` password was displayed on screen several times while
diagnosing a connection problem. That database accepts connections from the
public internet, so anyone holding the string can reach it.

1. Neon → project → **Roles** → reset the password for `neondb_owner`.
2. Update **both** `DATABASE_URL` and `DIRECT_URL` in Railway → production.
3. Redeploy, then run `verify:deploy` above.

When pasting into Railway, **leave off `&channel_binding=require`**. Neon's
copy-paste string includes it, `psql` accepts it, and Prisma's query engine
does not. Production works today because it is absent.

### Change the platform console password

The first password was generated during setup and has been handled a few times.
`POST /platform/auth/change-password` bumps the account's token version, so
every other session dies immediately.

---

# 3. Incorporation — *Adewale* — **gates signature, not usage**

The three legal documents have two blanks left, in six places: **RC number**
and **registered office address**. Both come from CAC registration, which has
not happened.

```
docs/legal/privacy-policy.md            2
docs/legal/terms-of-service.md          2
docs/legal/data-processing-agreement.md 2
```

This is not a formatting problem. Without incorporation there is no legal
entity to name as the contracting party in a processing agreement, and a
school's procurement will ask for the RC number. It also affects NDPC
registration, which identifies the controller or processor by entity.

**It does not stop the product working.** A school can use EduGear today. What
it stops is signing a data processing agreement as A4 Technologies Ltd.

Decide one of:

- **Register with CAC** and fill the six fields. Cleanest.
- **Contract in the name of the business as it exists** — a business name
  registration, or the proprietor personally — and say so accurately in the
  documents rather than leaving a blank.
- **Hold the documents** until CAC completes, and onboard pilot schools on a
  simpler written agreement in the meantime.

Whichever is chosen, the documents should say what is true. They were
deliberately rewritten so that every claim in them can be evidenced; a
fabricated RC number would undo that in the one field a lawyer checks first.

---

# 4. Insurance — *Adewale* — **gates signature**

Clause 15 of the processing agreement commits A4 Technologies to obtaining
cyber and data-protection liability cover **before processing personal data for
a school**. GAID Article 34(2)(r) makes an insurance clause mandatory, so it
cannot simply be deleted.

As written it is an obligation with a trigger, which is honest — but it binds
on signature. Cover needs to exist, or the clause needs renegotiating with the
school's knowledge.

---

# 5. Not blocking anything

| Item | Owner | Note |
| --- | --- | --- |
| Paystack live keys | Adewale | Cards only. Cash and bank transfer work today and are fully tested |
| NDPC registration + DPIA | Adewale | Required by law, slow to arrange, nobody checks on day one. Start it |
| Sentry alert rules | Ahmad | Errors are captured; nothing notifies anyone yet |
| Uptime check | Ahmad | `/api/health` from an external monitor |
| Neon restore drill | Ahmad | A backup nobody has restored is not a backup. Also fills the backup cadence left open in the DPA |
| MFA on the platform console | Adewale to decide | The console can suspend every school. Scoped, not built |
| Staging front-end CORS | Ahmad | Unverified because staging's front-end origin is unknown |
| Four unexplained users in production | Ahmad | Present before launch. Probably front-end testing, worth identifying |

---

# Things that will waste your time if nobody warns you

**Prisma says "Can't reach database server" for almost anything.** During setup
that one message stood for a missing `--` in an npm command, a placeholder
password pasted literally, and a dead IPv6 route. `psql` reported the real
cause first time. When a database connection fails, test it with `psql` before
believing Prisma's description of why.

**This machine's IPv6 is advertised but not routable.** Neon publishes both A
and AAAA records; `psql` falls back to IPv4, Prisma's Rust engine does not and
times out after exactly five seconds. If a tool hangs for five seconds and then
claims the host is unreachable, that is the signature.

**`npm run <script> --flag` does not pass the flag.** npm treats it as its own.
Use `npm run <script> -- --flag`, or call the script directly with `npx ts-node`.

**Railway settings are per environment.** Nothing carries across. Staging and
production were each configured by hand, and `docs/railway-service-settings.md`
is the record of what they should contain.
