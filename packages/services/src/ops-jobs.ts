import { applyDueConfigChanges } from "./ops-core";
import { runAttendanceAnomalies, runDeviceHealth, runAttendanceCutoffAlerts } from "./ops-attendance";
import { runTimeEntryExceptionAlerts, runProjectVarianceAlerts } from "./ops-time";
import { runLeaveEscalations, runAbsenceTransitions } from "./ops-leave";
import { runPayrollInputCutoffAlerts } from "./ops-payroll";
import { runAssignmentTransitions, runContractAlerts } from "./ops-lifecycle";
import { opsAddDays, opsDay } from "./ops-math";

/**
 * The nightly sweep for time, leave, payroll and lifecycle controls. Every
 * step is idempotent (alerts are de-duplicated in OpsAlertLog), so a rerun
 * sends nothing new.
 */
export async function runOpsJob(tenantId: string, now = new Date()): Promise<Record<string, number>> {
  const yesterday = opsAddDays(opsDay(now), -1);
  const configs = await applyDueConfigChanges(tenantId, now);
  const anomalies = await runAttendanceAnomalies(tenantId, opsAddDays(yesterday, -2), yesterday, { notify: true });
  const devices = await runDeviceHealth(tenantId, now);
  const attCutoff = await runAttendanceCutoffAlerts(tenantId, now);
  const timeAlerts = await runTimeEntryExceptionAlerts(tenantId, now);
  const variance = await runProjectVarianceAlerts(tenantId, now);
  const leave = await runLeaveEscalations(tenantId, now);
  const absences = await runAbsenceTransitions(tenantId, now);
  const payCutoff = await runPayrollInputCutoffAlerts(tenantId, now);
  const assignments = await runAssignmentTransitions(tenantId, now);
  const contracts = await runContractAlerts(tenantId, now);
  return {
    configChangesApplied: configs, anomaliesFound: anomalies.found, anomalyNotices: anomalies.notified, devicesOffline: devices.offline,
    attendanceCutoffNotices: attCutoff.sent, timeEntryAlerts: timeAlerts.alerted, projectVarianceAlerts: variance.alerted,
    leaveEscalations: leave.escalated, absencesStarted: absences.started, absenceReturnsOverdue: absences.overdue,
    payrollCutoffNotices: payCutoff.sent, assignmentsStarted: assignments.started, assignmentsOverdue: assignments.overdue, contractAlerts: contracts.sent,
  };
}
