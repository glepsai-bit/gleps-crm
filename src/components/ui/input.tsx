import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // BUG-018: alguns inputs (type=date/number/search) ignoram
          // bg-background em dark mode (browser usa cor padrao do form
          // control). dark:bg-input + [color-scheme:dark] forca o tema
          // certo. Tambem aplicado em inputs do ContactSidePanel + filtro
          // trigger name (prospeccao).
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-background dark:[color-scheme:dark] dark:text-white dark:placeholder:text-white/40",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
