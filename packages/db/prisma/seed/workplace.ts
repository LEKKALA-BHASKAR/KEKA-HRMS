import type { PrismaClient } from "@prisma/client";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];

/**
 * Seeds the workplace modules: announcements, awards, praise, assets,
 * documents, contracts, HR activities, training and meetings.
 */
export async function seedWorkplace(
  prisma: PrismaClient,
  ctx: {
    tenantId: string;
    employees: Array<{ id: string; number: string; doj: Date; ctc: number }>;
    locationIds: string[];
    departmentIds: Map<string, string>;
    empIdByNumber: Map<string, string>;
  },
) {
  const { tenantId, employees, locationIds, empIdByNumber } = ctx;
  const emp = (n: string) => empIdByNumber.get(n)!;

  // ---------------------------------------------------------------------
  //  Announcements
  // ---------------------------------------------------------------------
  const announcements = await Promise.all([
    prisma.announcement.create({
      data: {
        tenantId,
        title: "Revised leave policy effective 1 October",
        body:
          "Earned leave accrual moves from 18 to 21 days a year for all confirmed employees. " +
          "Carry-forward remains capped at 30 days. The sandwich rule on weekly offs is unchanged. " +
          "Please read the attached policy document and acknowledge it.",
        status: "PUBLISHED",
        publishAt: utc(2026, 9, 15),
        expiresAt: utc(2026, 12, 31),
        requireAck: true,
        notifyByEmail: true,
        isPinned: true,
        createdBy: emp("ACM0003"),
      },
    }),
    prisma.announcement.create({
      data: {
        tenantId,
        title: "Investment declaration window closes 22 January",
        body:
          "Submit your investment declarations and supporting proofs before 22 January. " +
          "Declarations approved after the cut-off will not affect TDS for this financial year. " +
          "If you are on the new regime, note that most Chapter VI-A deductions do not apply.",
        status: "PUBLISHED",
        publishAt: utc(2026, 9, 1),
        expiresAt: utc(2027, 1, 22),
        requireAck: false,
        isPinned: true,
        createdBy: emp("ACM0002"),
      },
    }),
    prisma.announcement.create({
      data: {
        tenantId,
        title: "Diwali holiday — office closed 8 to 10 November",
        body: "The Bengaluru, Mumbai, Chennai and Hyderabad offices will be closed. Support rotas are published separately.",
        status: "PUBLISHED",
        publishAt: utc(2026, 9, 20),
        expiresAt: utc(2026, 11, 11),
        createdBy: emp("ACM0019"),
      },
    }),
    prisma.announcement.create({
      data: {
        tenantId,
        title: "Q3 town hall — 15 October, 4pm",
        body: "Quarterly business review and the engineering roadmap. Attendance is expected for all confirmed employees.",
        status: "SCHEDULED",
        publishAt: utc(2026, 10, 1),
        audience: { excludeOnNotice: true },
        createdBy: emp("ACM0001"),
      },
    }),
  ]);

  // Reads and acknowledgements on the published ones.
  for (const [i, e] of employees.entries()) {
    if (i % 3 === 0) continue; // some people have not opened it yet
    await prisma.announcementRead.create({
      data: {
        announcementId: announcements[0].id,
        employeeId: e.id,
        viewedAt: utc(2026, 9, 16 + (i % 5)),
        acknowledgedAt: i % 4 === 0 ? null : utc(2026, 9, 16 + (i % 5)),
      },
    });
  }

  // ---------------------------------------------------------------------
  //  Awards and praise
  // ---------------------------------------------------------------------
  const awardTypes = await Promise.all([
    prisma.awardType.create({
      data: {
        tenantId, name: "Employee of the Month", cadence: "MONTHLY",
        description: "Outstanding individual contribution in the month.",
        icon: "star", color: "#f59e0b", cashAmount: 10000,
      },
    }),
    prisma.awardType.create({
      data: {
        tenantId, name: "Customer Champion", cadence: "QUARTERLY",
        description: "Went furthest for a customer.",
        icon: "heart", color: "#ec4899", cashAmount: 15000,
      },
    }),
    prisma.awardType.create({
      data: {
        tenantId, name: "Spot Recognition", cadence: "SPOT",
        description: "Immediate recognition for exceptional work.",
        icon: "zap", color: "#3b82f6", cashAmount: 5000, points: 500,
      },
    }),
    prisma.awardType.create({
      data: {
        tenantId, name: "Long Service — 10 Years", cadence: "ANNUAL",
        description: "A decade with Acme.",
        icon: "award", color: "#8b5cf6", cashAmount: 50000,
      },
    }),
  ]);

  const awardGrants: Array<[string, number, string, string]> = [
    ["ACM0006", 0, "2026-06", "Cut platform build times by 62% by reworking the CI cache strategy."],
    ["ACM0011", 0, "2026-07", "Caught a payroll rounding defect in QA before it reached a live run."],
    ["ACM0017", 1, "2026-Q2", "Retained a major account after a difficult migration."],
    ["ACM0009", 2, "2026-08", "Volunteered a weekend to unblock the statutory filing deadline."],
    ["ACM0029", 2, "2026-09", "Mentored three new joiners through their first production release."],
    ["ACM0004", 3, "2026", "Ten years leading engineering at Acme."],
  ];
  for (const [num, typeIdx, period, citation] of awardGrants) {
    const at = awardTypes[typeIdx];
    await prisma.employeeAward.create({
      data: {
        tenantId, awardTypeId: at.id, employeeId: emp(num),
        period, awardedOn: utc(2026, 6 + (typeIdx % 4), 28),
        citation, cashAmount: at.cashAmount,
        nominatedBy: emp("ACM0005"), approvedBy: emp("ACM0003"),
      },
    });
  }

  const badges = ["Team Player", "Above and Beyond", "Great Mentor", "Sharp Thinking", "Unblocked Me"];
  const praisePairs: Array<[string, string, string]> = [
    ["ACM0009", "ACM0007", "Reviewed my pull request at 11pm before the release. Thank you."],
    ["ACM0010", "ACM0006", "Explained the payroll formula engine until it finally clicked."],
    ["ACM0016", "ACM0015", "Took over my demo when I lost my voice. Saved the deal."],
    ["ACM0021", "ACM0020", "Patiently walked me through the PF reconciliation twice."],
    ["ACM0012", "ACM0011", "Wrote the regression test I should have written."],
    ["ACM0030", "ACM0029", "Spotted the ESI rounding issue in review."],
    ["ACM0013", "ACM0014", "Turned a vague brief into a design in a day."],
  ];
  for (const [from, to, message] of praisePairs) {
    await prisma.praise.create({
      data: {
        tenantId,
        fromEmployeeId: emp(from), toEmployeeId: emp(to),
        badge: pick(badges, praisePairs.findIndex((x) => x[0] === from)),
        message, isPublic: true,
        createdAt: utc(2026, 9, 10 + praisePairs.findIndex((x) => x[0] === from)),
      },
    });
  }

  // ---------------------------------------------------------------------
  //  Assets
  // ---------------------------------------------------------------------
  await prisma.assetIdSeries.create({
    data: { tenantId, name: "Default", prefix: "ACM-AST-", digits: 5, nextNumber: 1, isDefault: true },
  });

  const catLaptop = await prisma.assetCategory.create({
    data: { tenantId, name: "Computing", description: "Laptops, desktops and monitors", usefulLifeMonths: 36 },
  });
  const catMobile = await prisma.assetCategory.create({
    data: { tenantId, name: "Mobile & Communication", usefulLifeMonths: 24 },
  });
  const catFurniture = await prisma.assetCategory.create({
    data: { tenantId, name: "Furniture & Fixtures", usefulLifeMonths: 120 },
  });
  const catAccess = await prisma.assetCategory.create({
    data: { tenantId, name: "Access & Security", usefulLifeMonths: 60 },
  });

  const typeMbp = await prisma.assetType.create({
    data: { categoryId: catLaptop.id, name: "MacBook Pro 14", make: "Apple", model: "M4 Pro", requireAck: true },
  });
  const typeThinkpad = await prisma.assetType.create({
    data: { categoryId: catLaptop.id, name: "ThinkPad T14", make: "Lenovo", model: "Gen 5", requireAck: true },
  });
  const typeMonitor = await prisma.assetType.create({
    data: { categoryId: catLaptop.id, name: "27-inch Monitor", make: "Dell", model: "U2723QE", requireAck: false },
  });
  const typePhone = await prisma.assetType.create({
    data: { categoryId: catMobile.id, name: "iPhone 16", make: "Apple", model: "16", requireAck: true },
  });
  const typeChair = await prisma.assetType.create({
    data: { categoryId: catFurniture.id, name: "Ergonomic Chair", make: "Featherlite", requireAck: false },
  });
  const typeCard = await prisma.assetType.create({
    data: { categoryId: catAccess.id, name: "Access Card", requireAck: false },
  });

  const assetPlan: Array<{ type: string; cost: number; count: number }> = [
    { type: typeMbp.id, cost: 245000, count: 12 },
    { type: typeThinkpad.id, cost: 118000, count: 10 },
    { type: typeMonitor.id, cost: 48000, count: 14 },
    { type: typePhone.id, cost: 89000, count: 6 },
    { type: typeChair.id, cost: 22000, count: 8 },
    { type: typeCard.id, cost: 500, count: 32 },
  ];

  let tag = 1;
  const created: Array<{ id: string; typeId: string }> = [];
  for (const plan of assetPlan) {
    for (let i = 0; i < plan.count; i++) {
      const purchaseDate = utc(2024 + (i % 3), 1 + (i % 12), 10);
      // Straight-line depreciation to date.
      const monthsOwned = Math.max(0,
        (2026 - purchaseDate.getUTCFullYear()) * 12 + (9 - (purchaseDate.getUTCMonth() + 1)));
      const life = 36;
      const currentValue = Math.max(0, Math.round(plan.cost * (1 - Math.min(1, monthsOwned / life))));
      const a = await prisma.asset.create({
        data: {
          tenantId, assetTypeId: plan.type,
          assetTag: `ACM-AST-${String(tag++).padStart(5, "0")}`,
          serialNumber: `SN${(100000 + tag * 37).toString()}`,
          status: "AVAILABLE",
          condition: i % 9 === 0 ? "FAIR" : "GOOD",
          purchaseDate, purchaseCost: plan.cost,
          vendor: pick(["Redington India", "Ingram Micro", "Amazon Business", "Direct"], i),
          invoiceNumber: `INV-${2024 + (i % 3)}-${1000 + i}`,
          warrantyExpiry: utc(purchaseDate.getUTCFullYear() + 3, purchaseDate.getUTCMonth() + 1, 10),
          currentValue,
          locationId: pick(locationIds, i),
        },
      });
      created.push({ id: a.id, typeId: plan.type });
    }
  }

  // Assign a laptop, a monitor and an access card to most employees.
  const laptops = created.filter((a) => a.typeId === typeMbp.id || a.typeId === typeThinkpad.id);
  const monitors = created.filter((a) => a.typeId === typeMonitor.id);
  const cards = created.filter((a) => a.typeId === typeCard.id);

  for (const [i, e] of employees.entries()) {
    const laptop = laptops[i];
    if (laptop) {
      const assignedOn = e.doj > utc(2024, 1, 1) ? e.doj : utc(2024, 4, 1);
      await prisma.assetAssignment.create({
        data: {
          assetId: laptop.id, employeeId: e.id,
          assignedOn, assignedBy: empIdByNumber.get("ACM0022") ?? null,
          conditionOut: "GOOD",
          acknowledgedAt: i % 7 === 0 ? null : assignedOn,
        },
      });
      await prisma.asset.update({ where: { id: laptop.id }, data: { status: "ASSIGNED" } });
    }
    const monitor = monitors[i];
    if (monitor && i % 2 === 0) {
      await prisma.assetAssignment.create({
        data: {
          assetId: monitor.id, employeeId: e.id,
          assignedOn: utc(2025, 4, 1), conditionOut: "GOOD", acknowledgedAt: utc(2025, 4, 2),
        },
      });
      await prisma.asset.update({ where: { id: monitor.id }, data: { status: "ASSIGNED" } });
    }
    const card = cards[i];
    if (card) {
      await prisma.assetAssignment.create({
        data: { assetId: card.id, employeeId: e.id, assignedOn: e.doj, conditionOut: "NEW" },
      });
      await prisma.asset.update({ where: { id: card.id }, data: { status: "ASSIGNED" } });
    }
  }

  // A returned asset with a damage charge, which the F&F settlement picks up.
  const leaver = employees.find((e) => e.number === "ACM0027");
  if (leaver) {
    const damaged = created.find((a) => a.typeId === typePhone.id)!;
    await prisma.assetAssignment.create({
      data: {
        assetId: damaged.id, employeeId: leaver.id,
        assignedOn: utc(2025, 6, 1), conditionOut: "NEW",
        acknowledgedAt: utc(2025, 6, 1),
        returnedOn: utc(2026, 9, 20), conditionIn: "DAMAGED",
        damageCharge: 18000,
        damageNote: "Cracked display, outside warranty. Recoverable in the final settlement.",
      },
    });
    await prisma.asset.update({
      where: { id: damaged.id },
      data: { status: "IN_REPAIR", condition: "DAMAGED" },
    });
  }

  // Open asset requests.
  await prisma.assetRequest.create({
    data: {
      tenantId, employeeId: emp("ACM0024"), assetTypeId: typeMonitor.id,
      reason: "Second monitor for reviewing payroll registers side by side.",
      status: "PENDING", neededBy: utc(2026, 10, 15),
    },
  });
  await prisma.assetRequest.create({
    data: {
      tenantId, employeeId: emp("ACM0025"), assetTypeId: typeChair.id,
      reason: "Recommended by occupational health after a back injury.",
      status: "APPROVED", neededBy: utc(2026, 10, 5),
      approvedBy: emp("ACM0022"), approvedAt: utc(2026, 9, 22),
    },
  });

  // ---------------------------------------------------------------------
  //  Documents and contracts
  // ---------------------------------------------------------------------
  const folderStatutory = await prisma.documentFolder.create({
    data: {
      tenantId, name: "Statutory & Identity", scope: "EMPLOYEE",
      description: "PAN, Aadhaar, passport and other identity records",
      isConfidential: true,
      viewRoles: ["GLOBAL_ADMIN", "HR_MANAGER", "PAYROLL_ADMIN"],
      editRoles: ["GLOBAL_ADMIN", "HR_MANAGER"],
    },
  });
  const folderEducation = await prisma.documentFolder.create({
    data: { tenantId, name: "Education & Experience", scope: "EMPLOYEE" },
  });
  const folderPolicy = await prisma.documentFolder.create({
    data: { tenantId, name: "Company Policies", scope: "ORGANISATION" },
  });

  const dtPan = await prisma.documentType.create({
    data: { folderId: folderStatutory.id, name: "PAN Card", isMandatory: true, requireVerification: true },
  });
  const dtAadhaar = await prisma.documentType.create({
    data: { folderId: folderStatutory.id, name: "Aadhaar Card", isMandatory: true, requireVerification: true },
  });
  const dtPassport = await prisma.documentType.create({
    data: {
      folderId: folderStatutory.id, name: "Passport",
      isMandatory: false, trackExpiry: true, allowNotApplicable: true,
    },
  });
  const dtDegree = await prisma.documentType.create({
    data: { folderId: folderEducation.id, name: "Degree Certificate", isMandatory: true, allowMultiple: true },
  });
  const dtRelieving = await prisma.documentType.create({
    data: { folderId: folderEducation.id, name: "Previous Relieving Letter", isMandatory: true },
  });

  for (const [i, e] of employees.entries()) {
    // PAN and Aadhaar verified for most.
    await prisma.employeeDocument.create({
      data: {
        tenantId, employeeId: e.id, folderId: folderStatutory.id, documentTypeId: dtPan.id,
        name: "PAN Card", fileUrl: `/uploads/${e.number}/pan.pdf`,
        status: i % 11 === 0 ? "PENDING_VERIFICATION" : "VERIFIED",
        uploadedAt: e.doj, uploadedBy: e.id,
        verifiedAt: i % 11 === 0 ? null : e.doj,
        verifiedBy: i % 11 === 0 ? null : emp("ACM0019"),
      },
    });
    await prisma.employeeDocument.create({
      data: {
        tenantId, employeeId: e.id, folderId: folderStatutory.id, documentTypeId: dtAadhaar.id,
        name: "Aadhaar Card", fileUrl: `/uploads/${e.number}/aadhaar.pdf`,
        status: "VERIFIED", uploadedAt: e.doj, verifiedAt: e.doj, verifiedBy: emp("ACM0019"),
      },
    });
    // Passport: some expiring soon, which the expiry tracker surfaces.
    if (i % 4 === 0) {
      const expiresOn = utc(2026, 10 + (i % 3), 15);
      await prisma.employeeDocument.create({
        data: {
          tenantId, employeeId: e.id, folderId: folderStatutory.id, documentTypeId: dtPassport.id,
          name: "Passport", fileUrl: `/uploads/${e.number}/passport.pdf`,
          status: "VERIFIED", issuedOn: utc(2016, 10, 15), expiresOn,
          uploadedAt: e.doj, verifiedAt: e.doj,
        },
      });
    }
    await prisma.employeeDocument.create({
      data: {
        tenantId, employeeId: e.id, folderId: folderEducation.id, documentTypeId: dtDegree.id,
        name: "Degree Certificate",
        status: i % 6 === 0 ? "PENDING_ON_EMPLOYEE" : "VERIFIED",
        fileUrl: i % 6 === 0 ? null : `/uploads/${e.number}/degree.pdf`,
        uploadedAt: i % 6 === 0 ? null : e.doj,
      },
    });
    // New joiners still owe a relieving letter.
    if (e.doj >= utc(2026, 1, 1)) {
      await prisma.employeeDocument.create({
        data: {
          tenantId, employeeId: e.id, folderId: folderEducation.id, documentTypeId: dtRelieving.id,
          name: "Previous Relieving Letter", status: "PENDING_ON_EMPLOYEE",
        },
      });
    }
  }

  const orgDocs = await Promise.all([
    prisma.orgDocument.create({
      data: {
        tenantId, folderId: folderPolicy.id,
        title: "Employee Handbook", version: "4.2",
        description: "Conduct, working hours, communication norms and escalation paths.",
        fileUrl: "/policies/handbook-v4.2.pdf",
        effectiveFrom: utc(2026, 4, 1), requireAck: true,
      },
    }),
    prisma.orgDocument.create({
      data: {
        tenantId, folderId: folderPolicy.id,
        title: "Leave Policy", version: "2.1",
        fileUrl: "/policies/leave-v2.1.pdf",
        effectiveFrom: utc(2026, 10, 1), requireAck: true,
      },
    }),
    prisma.orgDocument.create({
      data: {
        tenantId, folderId: folderPolicy.id,
        title: "Information Security Policy", version: "3.0",
        fileUrl: "/policies/infosec-v3.0.pdf",
        effectiveFrom: utc(2026, 1, 1), requireAck: true,
      },
    }),
    prisma.orgDocument.create({
      data: {
        tenantId, folderId: folderPolicy.id,
        title: "Expense & Travel Policy", version: "1.8",
        fileUrl: "/policies/expense-v1.8.pdf",
        effectiveFrom: utc(2026, 4, 1), requireAck: false,
      },
    }),
  ]);

  for (const [i, e] of employees.entries()) {
    for (const [j, doc] of orgDocs.entries()) {
      if (!doc.requireAck) continue;
      // Leave the newest policy partly unacknowledged, so the tracker has work to show.
      if (j === 1 && i % 3 !== 0) continue;
      await prisma.orgDocumentAck.create({
        data: { documentId: doc.id, employeeId: e.id, acknowledgedAt: utc(2026, 4 + j, 5 + (i % 20)) },
      });
    }
  }

  // Letter templates.
  await prisma.documentTemplate.create({
    data: {
      tenantId, name: "Offer Letter", category: "OFFER",
      body: `<p>Dear {{candidate_name}},</p>
<p>We are pleased to offer you the position of <strong>{{job_title}}</strong> at {{legal_entity_name}},
based at {{location}}, reporting to {{reporting_manager}}.</p>
<p>Your annual cost to company will be <strong>{{annual_ctc}}</strong>, made up as follows:</p>
{{salary_breakup}}
<p>Your expected date of joining is {{joining_date}}. This offer is valid until {{offer_expiry}}.</p>
<p>This offer is subject to satisfactory background verification and receipt of your
relieving letter from your current employer.</p>
<p>Yours sincerely,<br/>{{signatory_name}}<br/>{{signatory_designation}}</p>`,
      placeholders: [
        "candidate_name", "job_title", "legal_entity_name", "location",
        "reporting_manager", "annual_ctc", "salary_breakup", "joining_date", "offer_expiry",
        "signatory_name", "signatory_designation",
      ],
      workflow: "SIGN",
    },
  });
  await prisma.documentTemplate.create({
    data: {
      tenantId, name: "Confirmation Letter", category: "CONFIRMATION",
      body: `<p>Dear {{employee_name}},</p>
<p>Following your probation review, we are pleased to confirm your appointment as
<strong>{{job_title}}</strong> with effect from {{confirmation_date}}.</p>
<p>Your notice period is now {{notice_days}} days, per the terms of your employment.</p>
<p>Congratulations, and thank you for your contribution so far.</p>
<p>{{signatory_name}}<br/>{{signatory_designation}}</p>`,
      placeholders: [
        "employee_name", "employee_number", "job_title", "confirmation_date",
        "notice_days", "signatory_name", "signatory_designation",
      ],
      workflow: "ACKNOWLEDGE",
    },
  });
  await prisma.documentTemplate.create({
    data: {
      tenantId, name: "Relieving Letter", category: "RELIEVING",
      body: `<p>To whom it may concern,</p>
<p>This is to certify that <strong>{{employee_name}}</strong> ({{employee_number}}) was employed with
{{legal_entity_name}} as {{job_title}} from {{date_of_joining}} to {{last_working_day}}.</p>
<p>All company dues and assets have been settled. We wish them well.</p>
<p>{{signatory_name}}<br/>{{signatory_designation}}</p>`,
      placeholders: [
        "employee_name", "employee_number", "legal_entity_name", "job_title",
        "date_of_joining", "last_working_day", "signatory_name", "signatory_designation",
      ],
    },
  });
  const expTemplate = await prisma.documentTemplate.create({
    data: {
      tenantId, name: "Experience Letter", category: "EXPERIENCE",
      body: `<p>This is to certify that <strong>{{employee_name}}</strong> worked at {{legal_entity_name}}
as {{job_title}} from {{date_of_joining}} to {{last_working_day}}.</p>
<p>{{signatory_name}}<br/>{{signatory_designation}}</p>`,
      placeholders: [
        "employee_name", "legal_entity_name", "job_title",
        "date_of_joining", "last_working_day", "signatory_name", "signatory_designation",
      ],
    },
  });

  // Contracts — a mix of permanent, fixed-term and one expiring soon.
  for (const [i, e] of employees.entries()) {
    const isContract = i % 9 === 0;
    const endDate = isContract ? utc(2026, 10 + (i % 3), 31) : null;
    await prisma.employeeContract.create({
      data: {
        tenantId, employeeId: e.id,
        contractNumber: `CON-${e.number}`,
        contractType: isContract ? "FIXED_TERM" : "PERMANENT",
        startDate: e.doj,
        endDate,
        status: endDate && endDate <= utc(2026, 11, 30) ? "EXPIRING" : "ACTIVE",
        contractValue: e.ctc,
        noticeDays: e.ctc > 3000000 ? 90 : 60,
        fileUrl: `/contracts/${e.number}.pdf`,
      },
    });
  }

  // ---------------------------------------------------------------------
  //  HR activities
  // ---------------------------------------------------------------------
  const activities: Array<Record<string, unknown>> = [
    {
      employeeId: emp("ACM0006"), type: "PROMOTION",
      title: "Promoted to Staff Engineer",
      description: "Consistent platform-level impact across two review cycles.",
      occurredOn: utc(2026, 4, 1), fromValue: "Senior Software Engineer", toValue: "Staff Engineer",
    },
    {
      employeeId: emp("ACM0005"), type: "PROMOTION",
      title: "Promoted to Engineering Manager",
      occurredOn: utc(2025, 10, 1), fromValue: "Staff Engineer", toValue: "Engineering Manager",
    },
    {
      employeeId: emp("ACM0011"), type: "TRANSFER",
      title: "Transferred from Bengaluru to Chennai",
      description: "Relocation at employee request. PT now follows the Tamil Nadu half-yearly schedule.",
      occurredOn: utc(2026, 4, 1), fromValue: "Bengaluru HQ", toValue: "Chennai Delivery Centre",
    },
    {
      employeeId: emp("ACM0027"), type: "WARNING",
      title: "Written warning — repeated unapproved absence",
      description: "Third instance in a quarter. Discussed with the reporting manager and HR.",
      occurredOn: utc(2026, 8, 12), severity: "MAJOR",
    },
    {
      employeeId: emp("ACM0015"), type: "WORK_TRIP",
      title: "Client visit — Mumbai to Singapore",
      description: "Annual review with the regional account.",
      occurredOn: utc(2026, 8, 3),
      tripFrom: utc(2026, 8, 3), tripTo: utc(2026, 8, 7), destination: "Singapore",
    },
    {
      employeeId: emp("ACM0017"), type: "WORK_TRIP",
      title: "Onsite implementation — Chennai to Kochi",
      occurredOn: utc(2026, 9, 8),
      tripFrom: utc(2026, 9, 8), tripTo: utc(2026, 9, 12), destination: "Kochi",
    },
    {
      employeeId: emp("ACM0007"), type: "APPRECIATION",
      title: "Letter of appreciation from the CEO",
      description: "Recovered a production incident inside the customer SLA.",
      occurredOn: utc(2026, 7, 22),
    },
    {
      employeeId: emp("ACM0027"), type: "RESIGNATION",
      title: "Resignation submitted",
      description: "Serving 60 days of notice. Last working day 20 November 2026.",
      occurredOn: utc(2026, 9, 21),
    },
  ];
  for (const a of activities) {
    await prisma.hrActivity.create({
      data: { tenantId, recordedBy: emp("ACM0003"), ...(a as never) },
    });
  }

  // ---------------------------------------------------------------------
  //  Training
  // ---------------------------------------------------------------------
  const ttInternal = await prisma.trainingType.create({
    data: { tenantId, name: "Internal Workshop", mode: "INTERNAL" },
  });
  const ttOnline = await prisma.trainingType.create({
    data: { tenantId, name: "Online Course", mode: "ONLINE" },
  });
  const ttCompliance = await prisma.trainingType.create({
    data: { tenantId, name: "Mandatory Compliance", mode: "ONLINE" },
  });
  const ttCert = await prisma.trainingType.create({
    data: { tenantId, name: "External Certification", mode: "CERTIFICATION" },
  });

  const programs = await Promise.all([
    prisma.trainingProgram.create({
      data: {
        tenantId, trainingTypeId: ttCompliance.id,
        title: "Prevention of Sexual Harassment (POSH)",
        description: "Statutory annual awareness training for all employees.",
        trainer: "External counsel", durationHours: 2,
        startDate: utc(2026, 7, 1), endDate: utc(2026, 7, 31),
        status: "COMPLETED", costPerHead: 400,
      },
    }),
    prisma.trainingProgram.create({
      data: {
        tenantId, trainingTypeId: ttCompliance.id,
        title: "Information Security Awareness",
        trainer: "Internal IT", durationHours: 1.5,
        startDate: utc(2026, 9, 1), endDate: utc(2026, 10, 15),
        status: "IN_PROGRESS", costPerHead: 0,
      },
    }),
    prisma.trainingProgram.create({
      data: {
        tenantId, trainingTypeId: ttInternal.id,
        title: "Indian Payroll Statutory Deep Dive",
        description: "PF, ESI, state PT and LWF, TDS projection and the six-step run.",
        trainer: "Ramesh Iyer", venue: "Bengaluru HQ, Training Room 1",
        durationHours: 8, maxSeats: 15,
        startDate: utc(2026, 10, 8), endDate: utc(2026, 10, 9),
        status: "PLANNED", costPerHead: 0,
        skills: ["Indian Payroll", "Statutory Compliance"],
      },
    }),
    prisma.trainingProgram.create({
      data: {
        tenantId, trainingTypeId: ttOnline.id,
        title: "Advanced PostgreSQL Performance",
        trainer: "Self-paced", durationHours: 20,
        startDate: utc(2026, 8, 1), endDate: utc(2026, 11, 30),
        status: "IN_PROGRESS", costPerHead: 3500,
        skills: ["PostgreSQL", "Query Optimisation"],
      },
    }),
    prisma.trainingProgram.create({
      data: {
        tenantId, trainingTypeId: ttCert.id,
        title: "AWS Solutions Architect — Associate",
        trainer: "AWS Training", durationHours: 40,
        startDate: utc(2026, 9, 1), endDate: utc(2026, 12, 31),
        status: "IN_PROGRESS", costPerHead: 12000,
        skills: ["AWS", "Cloud Architecture"],
      },
    }),
    prisma.trainingProgram.create({
      data: {
        tenantId, trainingTypeId: ttInternal.id,
        title: "First-Time Manager Programme",
        trainer: "Priya Sharma", venue: "Bengaluru HQ",
        durationHours: 16, maxSeats: 8,
        startDate: utc(2026, 11, 3), endDate: utc(2026, 11, 4),
        status: "PLANNED", costPerHead: 2000,
        skills: ["People Management", "Feedback"],
      },
    }),
  ]);

  // POSH and InfoSec go to everyone; the rest are targeted.
  for (const [i, e] of employees.entries()) {
    await prisma.trainingEnrolment.create({
      data: {
        programId: programs[0].id, employeeId: e.id,
        status: i % 13 === 0 ? "ASSIGNED" : "COMPLETED",
        progressPercent: i % 13 === 0 ? 0 : 100,
        completedAt: i % 13 === 0 ? null : utc(2026, 7, 10 + (i % 18)),
        score: i % 13 === 0 ? null : 80 + (i % 20),
        assignedBy: emp("ACM0003"),
      },
    });
    await prisma.trainingEnrolment.create({
      data: {
        programId: programs[1].id, employeeId: e.id,
        status: i % 3 === 0 ? "COMPLETED" : i % 3 === 1 ? "IN_PROGRESS" : "ASSIGNED",
        progressPercent: i % 3 === 0 ? 100 : i % 3 === 1 ? 45 + (i % 40) : 0,
        completedAt: i % 3 === 0 ? utc(2026, 9, 12 + (i % 10)) : null,
        assignedBy: emp("ACM0022"),
      },
    });
  }
  for (const num of ["ACM0002", "ACM0020", "ACM0021", "ACM0003", "ACM0019"]) {
    await prisma.trainingEnrolment.create({
      data: { programId: programs[2].id, employeeId: emp(num), status: "ASSIGNED", assignedBy: emp("ACM0002") },
    });
  }
  for (const num of ["ACM0006", "ACM0007", "ACM0029", "ACM0030"]) {
    await prisma.trainingEnrolment.create({
      data: {
        programId: programs[3].id, employeeId: emp(num),
        status: "IN_PROGRESS", progressPercent: 35 + (num.charCodeAt(6) % 50),
        assignedBy: emp("ACM0005"),
      },
    });
  }
  for (const num of ["ACM0006", "ACM0029"]) {
    await prisma.trainingEnrolment.create({
      data: { programId: programs[4].id, employeeId: emp(num), status: "IN_PROGRESS", progressPercent: 20, assignedBy: emp("ACM0004") },
    });
  }
  for (const num of ["ACM0005", "ACM0014", "ACM0017"]) {
    await prisma.trainingEnrolment.create({
      data: { programId: programs[5].id, employeeId: emp(num), status: "ASSIGNED", assignedBy: emp("ACM0003") },
    });
  }

  // ---------------------------------------------------------------------
  //  Meetings
  // ---------------------------------------------------------------------
  const rooms = await Promise.all([
    prisma.meetingRoom.create({
      data: {
        tenantId, name: "Bengaluru — Nilgiri (12)", locationId: locationIds[0], capacity: 12,
        facilities: ["Projector", "Video conferencing", "Whiteboard"],
      },
    }),
    prisma.meetingRoom.create({
      data: {
        tenantId, name: "Bengaluru — Kaveri (4)", locationId: locationIds[0], capacity: 4,
        facilities: ["Screen"],
      },
    }),
    prisma.meetingRoom.create({
      data: {
        tenantId, name: "Mumbai — Board Room (20)", locationId: locationIds[1], capacity: 20,
        facilities: ["Projector", "Video conferencing", "Speakerphone"],
      },
    }),
    prisma.meetingRoom.create({
      data: {
        tenantId, name: "Chennai — Marina (8)", locationId: locationIds[2], capacity: 8,
        facilities: ["Video conferencing", "Whiteboard"],
      },
    }),
  ]);

  const meetingPlan: Array<{
    title: string; type: string; room: number | null; url?: string;
    start: [number, number, number, number]; durationH: number;
    status: "SCHEDULED" | "COMPLETED"; agenda?: string; minutes?: string;
    organiser: string; attendees: string[];
    actions?: Array<{ description: string; owner: string; due: [number, number, number]; status?: string }>;
  }> = [
    {
      title: "Q3 Business Review", type: "TOWN_HALL", room: 2,
      start: [2026, 10, 15, 16], durationH: 2, status: "SCHEDULED",
      agenda: "Revenue against plan, engineering roadmap, hiring update, Q4 priorities.",
      organiser: "ACM0001",
      attendees: ["ACM0002", "ACM0003", "ACM0004", "ACM0015", "ACM0018", "ACM0023"],
    },
    {
      title: "Payroll close — September", type: "REVIEW", room: 1,
      start: [2026, 9, 26, 11], durationH: 1, status: "COMPLETED",
      agenda: "Review LOP adjustments, confirm statutory overrides, agree the lock date.",
      minutes:
        "Reviewed 28 employees. Two LOP adjustments confirmed with the reporting managers. " +
        "One PT override for the Chennai transfer agreed. Lock scheduled for 28 September, " +
        "with CFO approval required under maker-checker.",
      organiser: "ACM0002",
      attendees: ["ACM0020", "ACM0021", "ACM0003"],
      actions: [
        { description: "Raise the lock request for CFO approval", owner: "ACM0020", due: [2026, 9, 28] },
        { description: "Confirm the Chennai PT registration mapping", owner: "ACM0021", due: [2026, 9, 27], status: "DONE" },
        { description: "Circulate the pay register to Finance once locked", owner: "ACM0020", due: [2026, 9, 30] },
      ],
    },
    {
      title: "Platform weekly standup", type: "STANDUP", room: 1,
      start: [2026, 9, 28, 10], durationH: 0.5, status: "SCHEDULED",
      organiser: "ACM0005",
      attendees: ["ACM0006", "ACM0024", "ACM0029", "ACM0030"],
    },
    {
      title: "1:1 — Sneha and Karthik", type: "ONE_ON_ONE", room: 1,
      start: [2026, 9, 29, 15], durationH: 0.5, status: "SCHEDULED",
      organiser: "ACM0005", attendees: ["ACM0006"],
    },
    {
      title: "Hiring sync — Platform Engineer", type: "REVIEW", room: null,
      url: "https://meet.example.test/acm-hiring-sync",
      start: [2026, 9, 30, 14], durationH: 1, status: "SCHEDULED",
      agenda: "Pipeline review for the two open platform roles.",
      organiser: "ACM0019", attendees: ["ACM0004", "ACM0005", "ACM0003"],
    },
  ];

  for (const m of meetingPlan) {
    const [y, mo, d, h] = m.start;
    const startsAt = new Date(Date.UTC(y, mo - 1, d, h, 0));
    const endsAt = new Date(startsAt.getTime() + m.durationH * 3600_000);
    const meeting = await prisma.meeting.create({
      data: {
        tenantId,
        roomId: m.room !== null ? rooms[m.room].id : null,
        title: m.title, meetingType: m.type, agenda: m.agenda ?? null,
        startsAt, endsAt, meetingUrl: m.url ?? null,
        status: m.status, minutes: m.minutes ?? null,
        organiserId: emp(m.organiser),
        attendees: {
          create: [
            { employeeId: emp(m.organiser), attendance: "REQUIRED", response: "ACCEPTED", attended: m.status === "COMPLETED" ? true : null },
            ...m.attendees.map((num, i) => ({
              employeeId: emp(num),
              attendance: i > 3 ? "OPTIONAL" : "REQUIRED",
              response: m.status === "COMPLETED" ? "ACCEPTED" : i % 3 === 0 ? "PENDING" : "ACCEPTED",
              attended: m.status === "COMPLETED" ? i % 5 !== 0 : null,
            })),
          ],
        },
      },
    });
    for (const a of m.actions ?? []) {
      await prisma.meetingActionItem.create({
        data: {
          meetingId: meeting.id,
          description: a.description,
          ownerId: emp(a.owner),
          dueDate: utc(a.due[0], a.due[1], a.due[2]),
          status: a.status ?? "OPEN",
          completedAt: a.status === "DONE" ? utc(a.due[0], a.due[1], a.due[2]) : null,
        },
      });
    }
  }

  return {
    announcements: announcements.length,
    awardTypes: awardTypes.length,
    awards: awardGrants.length,
    praises: praisePairs.length,
    assets: created.length,
    orgDocuments: orgDocs.length,
    templates: 4,
    activities: activities.length,
    trainingPrograms: programs.length,
    meetings: meetingPlan.length,
    rooms: rooms.length,
  };
}
