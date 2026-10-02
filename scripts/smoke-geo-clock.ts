/**
 * Geo-fenced and selfie clock-in through the clock action: a policy that
 * requires both refuses a punch without a location, from outside the office
 * radius, or without a selfie; accepts one inside the fence with a photo
 * (giving GPS accuracy as tolerance at the edge); refuses a non-image
 * selfie; honours "mobile clock-in off"; and the selfie is downloadable by
 * an attendance viewer but not by another employee.
 *
 * Uses Meera with a temporary policy "Smoke geo policy" and temporary office
 * coordinates on her location; everything is restored at the end.
 */
import { signInAs, formData as fd, check, section, report } from "./_test-bootstrap";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
// Office at 12.9352, 77.6245; 0.001° of latitude is ~111 m.
const OFFICE = { lat: 12.9352, lng: 77.6245 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function punch(fields: Record<string, string>, selfie?: { data: Buffer; type: string }) {
  const f = fd(fields);
  if (selfie) f.append("selfie", new File([new Uint8Array(selfie.data)], "selfie.png", { type: selfie.type }));
  return f;
}

async function main() {
  const time = await import("../apps/web/src/app/actions/time");
  const files = await import("../apps/web/src/app/files/[id]/route");
  const { processAttendance } = await import("@keka/services");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "acme" } });
  const meera = await prisma.employee.findFirstOrThrow({ where: { tenantId: tenant.id, user: { email: "meera.krishnan@acme.test" } }, include: { location: true } });
  const loc = meera.location!;
  const before = { latitude: loc.latitude, longitude: loc.longitude, geofenceRadiusM: loc.geofenceRadiusM };
  const since = new Date();
  const today = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00Z`);
  // Clear any punch of Meera's in the last minute so the duplicate guard does not interfere.
  await prisma.attendanceLog.deleteMany({ where: { employeeId: meera.id, timestamp: { gte: new Date(Date.now() - 120_000) } } });

  const policy = await prisma.attendancePolicy.create({ data: { tenantId: tenant.id, name: "Smoke geo policy", allowWebClockIn: true, allowMobileClockIn: true, requireGeofence: true, requireSelfie: true } });
  const assignment = await prisma.employeeTimePolicy.create({ data: { employeeId: meera.id, attendancePolicyId: policy.id, effectiveFrom: new Date(today.getTime() - 86_400_000) } });
  await prisma.location.update({ where: { id: loc.id }, data: { latitude: OFFICE.lat, longitude: OFFICE.lng, geofenceRadiusM: 200 } });

  try {
    await signInAs("meera.krishnan@acme.test");
    section("Geo-fence");
    const noLoc = await time.clockAction({}, punch({ direction: "in" }, { data: PNG, type: "image/png" }));
    check("No location: refused", noLoc.ok !== true && /location/i.test(noLoc.message ?? ""), noLoc.message);
    const far = await time.clockAction({}, punch({ direction: "in", latitude: String(OFFICE.lat + 0.02), longitude: String(OFFICE.lng) }, { data: PNG, type: "image/png" }));
    check("2 km away: refused with the distance", far.ok !== true && /2\.2 km/.test(far.message ?? ""), far.message);
    check("A refused punch leaves no selfie behind", (await prisma.storedFile.count({ where: { employeeId: meera.id, relatedType: "AttendanceSelfie", createdAt: { gte: since } } })) === 0);

    section("Selfie");
    const noSelfie = await time.clockAction({}, punch({ direction: "in", latitude: String(OFFICE.lat), longitude: String(OFFICE.lng) }));
    check("Inside the fence without a selfie: refused", noSelfie.ok !== true && /selfie/i.test(noSelfie.message ?? ""), noSelfie.message);
    const text = await time.clockAction({}, punch({ direction: "in", latitude: String(OFFICE.lat), longitude: String(OFFICE.lng) }, { data: Buffer.from("not a photo at all"), type: "image/png" }));
    check("A selfie that is not an image: refused", text.ok !== true, text.message);
    const ok = await time.clockAction({}, punch({ direction: "in", latitude: String(OFFICE.lat + 0.001), longitude: String(OFFICE.lng), accuracy: "20" }, { data: PNG, type: "image/png" }));
    check("111 m away with a selfie: clocked in", ok.ok === true, ok.message);
    const log = await prisma.attendanceLog.findFirst({ where: { employeeId: meera.id, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });
    check("The punch keeps its location and selfie", !!log?.latitude && !!log.selfieUrl?.startsWith("/files/"), `${log?.latitude} ${log?.selfieUrl}`);

    const edge = await time.clockAction({}, punch({ direction: "out", latitude: String(OFFICE.lat + 0.0025), longitude: String(OFFICE.lng), accuracy: "80" }, { data: PNG, type: "image/png" }));
    check("278 m away with 80 m accuracy: given the benefit of the doubt", edge.ok === true, edge.message);
    const wide = await time.clockAction({}, punch({ direction: "in", latitude: String(OFFICE.lat + 0.004), longitude: String(OFFICE.lng), accuracy: "5000" }, { data: PNG, type: "image/png" }));
    check("444 m away claiming 5 km accuracy: tolerance is capped, refused", wide.ok !== true, wide.message);

    section("Mobile clock-in switch");
    await prisma.attendancePolicy.update({ where: { id: policy.id }, data: { allowMobileClockIn: false } });
    const mob = await time.clockAction({}, punch({ direction: "in", mode: "mobile", latitude: String(OFFICE.lat), longitude: String(OFFICE.lng) }, { data: PNG, type: "image/png" }));
    check("Mobile clock-in off: refused", mob.ok !== true && /Mobile clock-in/.test(mob.message ?? ""), mob.message);

    section("Who can see the selfie");
    const fileId = log!.selfieUrl!.split("/").pop()!;
    const get = () => files.GET(new Request(`http://x/files/${fileId}`), { params: Promise.resolve({ id: fileId }) });
    check("Meera can open her own selfie", (await get()).status === 200);
    await signInAs("priya.sharma@acme.test");
    check("HR (attendance viewer) can open it", (await get()).status === 200);
    await signInAs("aditya.verma@acme.test");
    const peer = await get();
    check("Another employee cannot", peer.status === 404, String(peer.status));
  } finally {
    await prisma.attendanceLog.deleteMany({ where: { employeeId: meera.id, createdAt: { gte: since } } });
    await prisma.storedFile.deleteMany({ where: { employeeId: meera.id, relatedType: "AttendanceSelfie", createdAt: { gte: since } } });
    await prisma.employeeTimePolicy.delete({ where: { id: assignment.id } });
    await prisma.attendancePolicy.delete({ where: { id: policy.id } });
    await prisma.location.update({ where: { id: loc.id }, data: before });
    await processAttendance({ employeeIds: [meera.id], from: today, to: today });
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: since }, entityType: "StoredFile" } });
  }
  report("Geo-fenced clock-in");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
