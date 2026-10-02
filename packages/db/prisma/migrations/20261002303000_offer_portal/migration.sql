-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "breakupSource" TEXT,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "renderedBody" TEXT,
ADD COLUMN     "salaryBreakup" JSONB,
ADD COLUMN     "signatureFileId" TEXT,
ADD COLUMN     "signedAt" TIMESTAMP(3),
ADD COLUMN     "signedIp" TEXT,
ADD COLUMN     "signedLetterUrl" TEXT,
ADD COLUMN     "signedUserAgent" TEXT,
ADD COLUMN     "signerName" TEXT;

-- CreateTable
CREATE TABLE "offer_links" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdBy" TEXT,
    "firstViewedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offer_links_tokenHash_key" ON "offer_links"("tokenHash");

-- CreateIndex
CREATE INDEX "offer_links_offerId_idx" ON "offer_links"("offerId");

-- AddForeignKey
ALTER TABLE "offer_links" ADD CONSTRAINT "offer_links_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

