/**
 * Access resolution, in isolation from the database.
 *
 * These pin the rules that are easy to get subtly wrong: the UNION of an
 * unscoped grant with the visibility setting, a malformed scope never
 * widening access, implicit roles reaching indirect reports, and the query
 * filter agreeing with the per-record check.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSIONS as P, ALL_PERMISSIONS, PERMISSION_GROUPS,
  SYSTEM_ROLES, IMPLICIT_ROLES, SELF_PERMISSIONS,
  canAccessEmployee, employeeScopeFilter, effectivePermissions, hasPermission,
  hasUnscopedPermission, implicitRolesOf,
  type ViewerContext, type TargetEmployee, type RoleGrant, type Permission,
} from "../src";

const NO_VISIBILITY = { restrictByLegalEntity: false, restrictByBusinessUnit: false, managerReporteeOverride: true };

function viewer(over: Partial<ViewerContext> = {}): ViewerContext {
  return {
    userId: "u-viewer", tenantId: "t1", employeeId: "e-viewer",
    grants: [], directReportIds: new Set(), allReportIds: new Set(),
    headedDepartmentIds: new Set(), headedBusinessUnitIds: new Set(),
    legalEntityId: "le-india", businessUnitId: "bu-tech",
    visibility: NO_VISIBILITY, ...over,
  };
}

function grant(permissions: Permission[], scopes: RoleGrant["scopes"] = []): RoleGrant {
  return { roleId: "r1", roleKey: null, roleName: "Test", permissions: new Set(permissions), scopes };
}

function target(over: Partial<TargetEmployee> = {}): TargetEmployee {
  return {
    id: "e-target", departmentId: "d-eng", locationId: "l-blr",
    legalEntityId: "le-india", businessUnitId: "bu-tech", reportingManagerId: "e-someone", ...over,
  };
}

/** Evaluate a Prisma-style where fragment against a plain record. */
function matches(where: Record<string, unknown> | null, rec: Record<string, unknown>): boolean {
  if (where === null) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matches(w, rec));
    if (k === "AND") return (v as Record<string, unknown>[]).every((w) => matches(w, rec));
    if (v && typeof v === "object" && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes(rec[k]);
    return rec[k] === v;
  });
}

describe("Self access", () => {
  test("every employee can see their own record for self permissions", () => {
    const v = viewer();
    assert.ok(canAccessEmployee(v, target({ id: "e-viewer" }), P.LEAVE_VIEW));
    assert.ok(canAccessEmployee(v, target({ id: "e-viewer" }), P.ATTENDANCE_VIEW));
  });

  test("self access does not extend to permissions outside the self set", () => {
    const v = viewer();
    assert.equal(canAccessEmployee(v, target({ id: "e-viewer" }), P.LEAVE_APPROVE), false);
    assert.equal(canAccessEmployee(v, target({ id: "e-viewer" }), P.LEAVE_MANAGE), false);
  });

  test("a login with no employee record has no self access", () => {
    const v = viewer({ employeeId: null });
    assert.equal(effectivePermissions(v).has(P.LEAVE_VIEW), false);
  });

  test("self access never reaches a colleague", () => {
    assert.equal(canAccessEmployee(viewer(), target(), P.LEAVE_VIEW), false);
  });
});

describe("Explicit grants", () => {
  test("an unscoped grant reaches everyone", () => {
    const v = viewer({ grants: [grant([P.EMPLOYEE_VIEW])] });
    assert.ok(canAccessEmployee(v, target(), P.EMPLOYEE_VIEW));
    assert.ok(hasUnscopedPermission(v, P.EMPLOYEE_VIEW));
  });

  test("a department-scoped grant reaches that department only", () => {
    const v = viewer({ grants: [grant([P.EMPLOYEE_VIEW], [{ departmentId: "d-eng" }])] });
    assert.ok(canAccessEmployee(v, target(), P.EMPLOYEE_VIEW));
    assert.equal(canAccessEmployee(v, target({ departmentId: "d-sales" }), P.EMPLOYEE_VIEW), false);
    assert.equal(hasUnscopedPermission(v, P.EMPLOYEE_VIEW), false);
  });

  test("a scope naming department and location needs both", () => {
    const v = viewer({ grants: [grant([P.EMPLOYEE_VIEW], [{ departmentId: "d-eng", locationId: "l-blr" }])] });
    assert.ok(canAccessEmployee(v, target(), P.EMPLOYEE_VIEW));
    assert.equal(canAccessEmployee(v, target({ locationId: "l-hyd" }), P.EMPLOYEE_VIEW), false);
  });

  test("several scopes on one grant are alternatives", () => {
    const v = viewer({ grants: [grant([P.EMPLOYEE_VIEW], [{ departmentId: "d-eng" }, { locationId: "l-hyd" }])] });
    assert.ok(canAccessEmployee(v, target({ departmentId: "d-sales", locationId: "l-hyd" }), P.EMPLOYEE_VIEW));
  });

  test("a malformed empty scope never widens access", () => {
    const v = viewer({ grants: [grant([P.EMPLOYEE_VIEW], [{}])] });
    assert.equal(canAccessEmployee(v, target(), P.EMPLOYEE_VIEW), false);
    assert.equal(hasUnscopedPermission(v, P.EMPLOYEE_VIEW), false);
  });

  test("a grant covers only the permissions it carries", () => {
    const v = viewer({ grants: [grant([P.EMPLOYEE_VIEW])] });
    assert.equal(canAccessEmployee(v, target(), P.SALARY_REVISE), false);
  });
});

describe("Implicit roles", () => {
  test("are derived from position, not assignment", () => {
    assert.deepEqual(implicitRolesOf(viewer()), []);
    const mgr = viewer({ directReportIds: new Set(["e-target"]), allReportIds: new Set(["e-target"]) });
    assert.deepEqual(implicitRolesOf(mgr), ["REPORTING_MANAGER"]);
  });

  test("a reporting manager reaches indirect reports", () => {
    const v = viewer({ directReportIds: new Set(["e-mid"]), allReportIds: new Set(["e-mid", "e-target"]) });
    assert.ok(canAccessEmployee(v, target(), P.LEAVE_APPROVE));
  });

  test("a reporting manager cannot use permissions the implicit role lacks", () => {
    const v = viewer({ directReportIds: new Set(["e-target"]), allReportIds: new Set(["e-target"]) });
    assert.equal(canAccessEmployee(v, target(), P.SALARY_REVISE), false);
    assert.equal(canAccessEmployee(v, target(), P.LEAVE_MANAGE), false);
  });

  test("a department head reaches the whole department, and nobody else", () => {
    const v = viewer({ headedDepartmentIds: new Set(["d-eng"]) });
    assert.ok(canAccessEmployee(v, target(), P.ATTENDANCE_APPROVE));
    assert.equal(canAccessEmployee(v, target({ departmentId: "d-sales" }), P.ATTENDANCE_APPROVE), false);
  });

  test("a business head reaches the business unit", () => {
    const v = viewer({ headedBusinessUnitIds: new Set(["bu-tech"]) });
    assert.ok(canAccessEmployee(v, target(), P.EXIT_APPROVE));
  });

  test("implicit permissions show in the menu set but do not reach strangers", () => {
    const v = viewer({ directReportIds: new Set(["e-x"]), allReportIds: new Set(["e-x"]) });
    assert.ok(hasPermission(v, P.LEAVE_APPROVE));
    assert.equal(canAccessEmployee(v, target(), P.LEAVE_APPROVE), false);
  });
});

describe("Visibility — scope of privilege UNION scope of visibility", () => {
  const restricted = { restrictByLegalEntity: true, restrictByBusinessUnit: false, managerReporteeOverride: true };

  test("an unscoped grant ignores the visibility restriction", () => {
    const v = viewer({ grants: [grant([P.EMPLOYEE_VIEW])], visibility: restricted });
    assert.ok(canAccessEmployee(v, target({ legalEntityId: "le-uk" }), P.EMPLOYEE_VIEW));
  });

  test("a scoped grant is narrowed by it", () => {
    const v = viewer({ grants: [grant([P.EMPLOYEE_VIEW], [{ departmentId: "d-eng" }])], visibility: restricted });
    assert.equal(canAccessEmployee(v, target({ legalEntityId: "le-uk" }), P.EMPLOYEE_VIEW), false);
    assert.ok(canAccessEmployee(v, target(), P.EMPLOYEE_VIEW));
  });

  test("a manager keeps sight of a report in another entity", () => {
    const v = viewer({ directReportIds: new Set(["e-target"]), allReportIds: new Set(["e-target"]), visibility: restricted });
    assert.ok(canAccessEmployee(v, target({ legalEntityId: "le-uk" }), P.LEAVE_APPROVE));
  });

  test("…unless the override is switched off", () => {
    const v = viewer({
      directReportIds: new Set(["e-target"]), allReportIds: new Set(["e-target"]),
      visibility: { ...restricted, managerReporteeOverride: false },
    });
    assert.equal(canAccessEmployee(v, target({ legalEntityId: "le-uk" }), P.LEAVE_APPROVE), false);
  });

  test("business-unit restriction applies the same way", () => {
    const v = viewer({
      headedDepartmentIds: new Set(["d-eng"]),
      visibility: { restrictByLegalEntity: false, restrictByBusinessUnit: true, managerReporteeOverride: true },
    });
    assert.equal(canAccessEmployee(v, target({ businessUnitId: "bu-ops" }), P.LEAVE_APPROVE), false);
  });
});

describe("Query filter agrees with the record check", () => {
  const people: TargetEmployee[] = [
    target({ id: "e-viewer" }),
    target({ id: "e-report", reportingManagerId: "e-viewer" }),
    target({ id: "e-skip", reportingManagerId: "e-report" }),
    target({ id: "e-eng" }),
    target({ id: "e-sales", departmentId: "d-sales" }),
    target({ id: "e-hyd", departmentId: "d-sales", locationId: "l-hyd" }),
    target({ id: "e-uk", legalEntityId: "le-uk", departmentId: "d-eng" }),
    target({ id: "e-ops", businessUnitId: "bu-ops", departmentId: "d-ops" }),
  ];
  const cases: Array<[string, ViewerContext]> = [
    ["plain employee", viewer()],
    ["manager", viewer({ directReportIds: new Set(["e-report"]), allReportIds: new Set(["e-report", "e-skip"]) })],
    ["department head", viewer({ headedDepartmentIds: new Set(["d-sales"]) })],
    ["scoped HR", viewer({ grants: [grant([P.LEAVE_VIEW, P.LEAVE_APPROVE], [{ locationId: "l-hyd" }])] })],
    ["scoped HR, entity-restricted", viewer({
      grants: [grant([P.LEAVE_VIEW, P.LEAVE_APPROVE], [{ departmentId: "d-eng" }])],
      visibility: { restrictByLegalEntity: true, restrictByBusinessUnit: false, managerReporteeOverride: true },
    })],
    ["global HR", viewer({ grants: [grant([P.LEAVE_VIEW, P.LEAVE_APPROVE])] })],
  ];

  for (const [label, v] of cases) {
    for (const perm of [P.LEAVE_VIEW, P.LEAVE_APPROVE] as const) {
      test(`${label} — ${perm}`, () => {
        const where = employeeScopeFilter(v, perm);
        for (const p of people) {
          assert.equal(
            matches(where, p as unknown as Record<string, unknown>),
            canAccessEmployee(v, p, perm),
            `${p.id}: filter and check disagree`,
          );
        }
      });
    }
  }

  test("no route to a permission yields a never-match filter, not 'everyone'", () => {
    const where = employeeScopeFilter(viewer({ employeeId: null }), P.LEAVE_APPROVE);
    assert.deepEqual(where, { id: "__no_access__" });
  });

  test("an unscoped grant yields no filter at all", () => {
    assert.equal(employeeScopeFilter(viewer({ grants: [grant([P.LEAVE_VIEW])] }), P.LEAVE_VIEW), null);
  });
});

describe("Catalog integrity", () => {
  const known = new Set<string>(ALL_PERMISSIONS);

  test("permission keys are unique", () => {
    assert.equal(known.size, ALL_PERMISSIONS.length);
  });

  test("every permission appears in exactly one role-builder group", () => {
    const seen = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
    assert.equal(new Set(seen).size, seen.length, "a permission is listed twice");
    const missing = ALL_PERMISSIONS.filter((p) => !seen.includes(p));
    assert.deepEqual(missing, [], "permissions missing from the role builder");
  });

  test("system, implicit and self roles reference only real permissions", () => {
    for (const r of SYSTEM_ROLES) for (const p of r.permissions) assert.ok(known.has(p), `${r.key}: ${p}`);
    for (const r of IMPLICIT_ROLES) for (const p of r.permissions) assert.ok(known.has(p), `${r.key}: ${p}`);
    for (const p of SELF_PERMISSIONS) assert.ok(known.has(p), `self: ${p}`);
  });

  test("no implicit or self role can manage policy or run payroll", () => {
    const dangerous: Permission[] = [P.LEAVE_MANAGE, P.ATTENDANCE_MANAGE, P.PAYROLL_RUN, P.ROLE_MANAGE, P.SALARY_REVISE];
    for (const r of IMPLICIT_ROLES) for (const p of dangerous) assert.ok(!r.permissions.includes(p), `${r.key} holds ${p}`);
    for (const p of dangerous) assert.ok(!SELF_PERMISSIONS.includes(p), `self holds ${p}`);
  });

  test("system role keys are unique", () => {
    assert.equal(new Set(SYSTEM_ROLES.map((r) => r.key)).size, SYSTEM_ROLES.length);
  });
});
