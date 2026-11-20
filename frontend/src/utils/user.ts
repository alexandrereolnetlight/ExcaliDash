export const getInitialsFromName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return "U";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
};

/** Plain https URL or undefined; guards avatar URLs handed to Excalidraw. */
export const toHttpsAvatarUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
};
