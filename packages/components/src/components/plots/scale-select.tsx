import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lunar-spice/components/ui/select";

/**
 * A compact dropdown of scales, such as a scope's time span, keyed by value. A
 * `className` such as a fixed width keeps it from resizing as the scale changes.
 */
export function ScaleSelect({
  label,
  value,
  options,
  className,
  onChange,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        const match = Object.keys(options).find((key) => key === next);

        if (match !== undefined) {
          onChange(match);
        }
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {Object.entries(options).map(([key, text]) => (
          <SelectItem key={key} value={key}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
