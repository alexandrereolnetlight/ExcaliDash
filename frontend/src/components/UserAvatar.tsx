import React, { useState } from "react";
import clsx from "clsx";
import { getInitialsFromName } from "../utils/user";

type UserAvatarProps = {
  name: string;
  /** Profile picture URL; falls back to initials when absent or broken. */
  avatarUrl?: string | null;
  size?: "sm" | "toolbar" | "md" | "lg";
  className?: string;
};

const sizeClasses = {
  sm: "h-8 w-8 text-[11px]",
  toolbar: "h-10 w-10 text-xs",
  md: "h-12 w-12 text-sm",
  lg: "h-20 w-20 text-2xl",
};

export const UserAvatar: React.FC<UserAvatarProps> = ({
  name,
  avatarUrl,
  size = "md",
  className,
}) => {
  // Remember which URL failed, so a changed avatarUrl gets a fresh attempt.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl = avatarUrl && avatarUrl !== failedUrl ? avatarUrl : null;

  return (
    <div
      className={clsx("playful-avatar", sizeClasses[size], className)}
      aria-label={`${name}'s profile picture`}
      role="img"
    >
      {imageUrl ? (
        // Decorative: the wrapper carries the accessible name.
        <img
          src={imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          draggable={false}
          // Inherit the wrapper's rounded shape so the photo fills it exactly.
          className="absolute inset-0 h-full w-full rounded-[inherit] object-cover"
          onError={() => setFailedUrl(imageUrl)}
        />
      ) : (
        getInitialsFromName(name)
      )}
    </div>
  );
};
