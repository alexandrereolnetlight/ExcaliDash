-- In-editor AI assistant: optional per-user personal LLM proxy key (stored
-- AES-256-GCM encrypted, only the last four characters in clear) and a flag
-- for the short-lived API keys minted per assistant request.
-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "ephemeral" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UserAiCredential" (
    "userId" TEXT NOT NULL,
    "keyEncrypted" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "validatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAiCredential_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserAiCredential" ADD CONSTRAINT "UserAiCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
