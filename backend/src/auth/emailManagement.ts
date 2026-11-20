import type { PrismaClient } from "../generated/client";
import { config } from "../config";
import { OIDC_PROVIDER_KEY } from "./oidcRouteHelpers";

/**
 * A user's email is owned by the identity provider (and must not be edited in
 * the app) when the account is linked to an OIDC identity, or when the app
 * runs in oidc_enforced mode where every account's email comes from the IdP.
 * Changing it locally would desynchronise the account from the IdP and could
 * let it collide with, or be matched by, another person's OIDC login.
 */
export const isEmailManagedByIdentityProvider = async (
  prisma: Pick<PrismaClient, "authIdentity">,
  userId: string,
): Promise<boolean> => {
  if (config.authMode === "oidc_enforced") return true;
  const identity = await prisma.authIdentity.findFirst({
    where: { userId, provider: OIDC_PROVIDER_KEY },
    select: { id: true },
  });
  return identity !== null;
};
