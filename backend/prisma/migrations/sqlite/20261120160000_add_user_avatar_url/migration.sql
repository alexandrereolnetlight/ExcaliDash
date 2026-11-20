-- Profile picture URL resolved from the Netlight API at OIDC login.
-- Only the (public) URL is stored, never the image itself.
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;
