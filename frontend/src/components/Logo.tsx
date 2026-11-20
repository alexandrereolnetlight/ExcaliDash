import React from "react";

// Excalight logo (rounded square, corner radius 1024 * 2/9), served from
// frontend/public/logo.svg. Decorative: the product name is always rendered
// next to it or in the page heading.
export const Logo: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <img
      src="/logo.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  );
};
