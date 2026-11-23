-- In-editor AI assistant: optional per-user personal LLM proxy key (stored
-- AES-256-GCM encrypted, only the last four characters in clear) and a flag
-- for the short-lived API keys minted per assistant request.
-- CreateTable
CREATE TABLE "UserAiCredential" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "keyEncrypted" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "validatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserAiCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- A NOT NULL column with a constant default is a valid SQLite ADD COLUMN target.
ALTER TABLE "ApiKey" ADD COLUMN "ephemeral" BOOLEAN NOT NULL DEFAULT false;
