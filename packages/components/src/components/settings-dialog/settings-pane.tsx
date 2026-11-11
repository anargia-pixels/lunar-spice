import type { ReactNode } from "react";

/**
 * Frame for one settings section: its title and what it covers, then its content, at a
 * single readable width centered beside the settings sidebar.
 */
export function SettingsPane({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="h-full overflow-auto select-none">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-medium">{title}</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            {description}
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}
