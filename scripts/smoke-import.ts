/**
 * Bulk import through the action: who may import what; the check pass
 * reporting every problem by spreadsheet line and changing nothing; the
 * import pass refusing a file with any bad row; then a clean import of
 * employees (one reporting to another created in the same file), leave
 * opening balances, a salary revision and a bank account, each landing
 * exactly as the single-record screens would leave it.
 *
 * Everything is created under employee numbers SMKIMP… and removed at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function denied(fn: () => Promise<unknown>) {
  try { await fn(); return false; } catch (e) { return /HTTP_ERROR_FALLBACK;403/.test((e as { digest?: string }).digest ?? ""); }
}

const EMP_HEADER = "Employee number,First name,Last name,Work email,Date of joining,Legal entity,Location,Department,Job title,Reporting manager,Pay group,Annual CTC,Invite to portal";

async function main() {
  const act = await import("../apps/web/src/app/actions/import");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const run = (kind: string, mode: string, file: string) => act.runImportAction({}, fd({ kind, mode, file }));
  const ours = () => prisma.employee.findMany({ where: { tenantId: tenant.id, employeeNumber: { startsWith: "SMKIMP" } }, orderBy: { employeeNumber: "asc" } });

  console.log("\nBulk import\n" + "=".repeat(72));
  try {
    // -----------------------------------------------------------------------
    section("Access");
    await signInAs("meera.krishnan@acme.test");
    check("An employee cannot import employees", await denied(() => run("employees", "check", EMP_HEADER)));
    await signInAs("manish.tiwari@acme.test");
    check("A read-only finance role cannot import salaries", await denied(() => run("salaries", "check", "Employee number,Effective from,Annual CTC")));

    // -----------------------------------------------------------------------
    section("Checking a file");
    await signInAs("vikram.menon@acme.test");
    const missingCol = await run("employees", "check", "First name,Last name\nA,B");
    check("A file without required columns is refused, naming them", missingCol.ok === false && /Work email/.test(missingCol.message ?? ""), missingCol.message);
    const bad = await run("employees", "check", [
      EMP_HEADER + ",Shoe size",
      "SMKIMP01,Asha,Pillai,asha.smk@acme.test,31/02/2026,Acme Technologies,Bengaluru HQ,,,,,,no,7",
      "SMKIMP02,Ravi,Kumar,vikram.menon@acme.test,2026-10-01,Acme Technologies,Atlantis,,,,,,no,",
      "SMKIMP03,Lata,Rao,lata.smk@acme.test,2026-10-01,Acme Technologies,Bengaluru HQ,,,,,900000,maybe,",
    ].join("\n"));
    const lines = (bad.rowErrors ?? []).map((e) => e.line);
    check("Every bad row is reported by its spreadsheet line", bad.ok === false && lines.join() === "2,3,4", JSON.stringify(bad.rowErrors));
    check("…with what is wrong in each", /not a date/.test(bad.rowErrors?.[0]?.message ?? "") && /already belongs/.test(bad.rowErrors?.[1]?.message ?? "") && /Atlantis/.test(bad.rowErrors?.[1]?.message ?? "") && /pay group is required/.test(bad.rowErrors?.[2]?.message ?? "") && /yes or no/.test(bad.rowErrors?.[2]?.message ?? ""));
    check("…and unknown columns are named", /Shoe size/.test(bad.message ?? ""), bad.message);
    const refused = await run("employees", "import", bad.message ? EMP_HEADER + "\nSMKIMP01,Asha,Pillai,asha.smk@acme.test,31/02/2026,Acme Technologies,Bengaluru HQ,,,,,,no" : "");
    check("Import refuses a file with any bad row and creates nothing", refused.ok === false && (await ours()).length === 0, refused.message);

    // -----------------------------------------------------------------------
    section("Importing employees");
    const good = [
      EMP_HEADER,
      "SMKIMP01,Asha,Pillai,asha.smk@acme.test,01/10/2026,Acme Technologies,Bengaluru HQ,Product Engineering,Engineering Manager,ACM0002,Acme India — Monthly,\"24,00,000\",yes",
      "SMKIMP02,Ravi,Kumar,ravi.smk@acme.test,2026-10-01,acme technologies,bengaluru hq,product engineering,Software Engineer,SMKIMP01,Acme India — Monthly,1200000,no",
    ].join("\r\n");
    const ok = await run("employees", "check", good);
    check("A clean file checks out and changes nothing", ok.ok === true && ok.checked === 2 && (await ours()).length === 0, ok.message);
    const imp = await run("employees", "import", good);
    const [asha, ravi] = await ours();
    check("Import creates every row", imp.ok === true && imp.imported === 2 && !!asha && !!ravi, `${imp.message} ${JSON.stringify(imp.rowErrors)}`);
    check("A manager created earlier in the same file is linked", ravi?.reportingManagerId === asha?.id);
    check("Names match regardless of case", ravi?.departmentId === asha?.departmentId && !!asha?.departmentId);
    const rev = asha ? await prisma.salaryRevision.findFirst({ where: { employeeId: asha.id } }) : null;
    check("The opening salary is laid down, Indian grouping read correctly", Number(rev?.annualCtc) === 2400000);
    check("Invite to portal creates a login only where asked", !!asha?.userId && !ravi?.userId);
    check("Joining starts the onboarding journey, as a single hire does", asha ? (await prisma.journey.count({ where: { employeeId: asha.id, trigger: "JOINING" } })) === 1 : false);
    const again = await run("employees", "check", good);
    check("Importing the same file twice is caught by the check", again.ok === false && (again.rowErrors?.length ?? 0) === 2, again.message);

    // -----------------------------------------------------------------------
    section("Balances, salaries and bank accounts");
    const el = await prisma.leaveType.findFirstOrThrow({ where: { tenantId: tenant.id, code: "EL" } });
    const bal = await run("leave-balances", "import", "Employee number,Leave type,Days,Note\nSMKIMP01,EL,6.5,\nSMKIMP02,Earned Leave,3,From old HRMS");
    const entries = asha ? await prisma.leaveLedgerEntry.findMany({ where: { employeeId: { in: [asha.id, ravi.id] }, leaveTypeId: el.id } }) : [];
    check("Leave opening balances land on the ledger, by code or name", bal.ok === true && entries.length >= 2 && entries.some((e) => Number(e.days) === 6.5), `${bal.message} ${JSON.stringify(bal.rowErrors)}`);
    const sal = await run("salaries", "import", "Employee number,Effective from,Annual CTC,Reason\nSMKIMP02,2026-11-01,1350000,Smoke revision");
    const latest = ravi ? await prisma.salaryRevision.findFirst({ where: { employeeId: ravi.id }, orderBy: { effectiveFrom: "desc" } }) : null;
    check("A salary revision is applied through the same rules as a single one", sal.ok === true && Number(latest?.annualCtc) === 1350000, `${sal.message} ${JSON.stringify(sal.rowErrors)}`);
    const badBank = await run("bank-accounts", "check", "Employee number,Bank name,Account number,IFSC\nSMKIMP01,HDFC Bank,12AB,HDFC1234");
    check("Bank rows with a bad account number or IFSC are caught", badBank.ok === false && /6–20 digits/.test(badBank.rowErrors?.[0]?.message ?? "") && /IFSC/.test(badBank.rowErrors?.[0]?.message ?? ""));
    const bank = await run("bank-accounts", "import", "Employee number,Bank name,Account number,IFSC,Primary\nSMKIMP01,HDFC Bank,50100123456789,hdfc0001234,yes");
    const acct = asha ? await prisma.employeeBankAccount.findFirst({ where: { employeeId: asha.id } }) : null;
    check("A bank account is added as primary, IFSC upper-cased", bank.ok === true && acct?.isPrimary === true && acct?.ifsc === "HDFC0001234", `${bank.message} ${JSON.stringify(bank.rowErrors)}`);
    const audit = await prisma.auditLog.count({ where: { tenantId: tenant.id, entityType: "BulkImport", createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } });
    check("Each import is audited as a whole, as well as row by row", audit >= 4, `${audit}`);
  } finally {
    const created = await ours();
    const userIds = created.map((e) => e.userId).filter((x): x is string => !!x);
    await prisma.employee.updateMany({ where: { id: { in: created.map((e) => e.id) } }, data: { reportingManagerId: null } });
    await prisma.employee.deleteMany({ where: { id: { in: created.map((e) => e.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, OR: [{ entityType: "BulkImport" }, { summary: { contains: "SMKIMP" } }] } });
  }
  report("Bulk import");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
