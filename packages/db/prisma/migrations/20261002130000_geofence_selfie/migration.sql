-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "geofenceRadiusM" INTEGER,
ADD COLUMN     "latitude" DECIMAL(10,7),
ADD COLUMN     "longitude" DECIMAL(10,7);

-- AlterTable
ALTER TABLE "attendance_policies" ADD COLUMN     "requireGeofence" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireSelfie" BOOLEAN NOT NULL DEFAULT false;

